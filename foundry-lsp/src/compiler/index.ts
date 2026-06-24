import { Diagnostic, DiagnosticSeverity } from 'vscode-languageserver';
import { URI } from 'vscode-uri';
import { execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';
import { projectManager, FoundryProject } from '../project';
import { CompileCache, CompileResult } from './cache';
import { SourceUnit, AstNode, isImportDirective, ImportDirective } from '../ast/types';
import { parseDiagnostics } from './diagnostics';
import { globalIndex } from '../indexer';
import { findImports } from '../ast/traversal';

const execFileAsync = promisify(execFile);

export class CompilerManager {
  private cache = new CompileCache();
  private debounceTimers = new Map<string, NodeJS.Timeout>();
  private dependencyGraph = new Map<string, Set<string>>();
  private inverseDeps = new Map<string, Set<string>>();

  async compile(uri: string, content: string): Promise<CompileResult | null> {
    const cached = this.cache.get(uri, content);
    if (cached) {
      return cached;
    }

    const project = projectManager.getProject(uri);
    if (!project) {
      return null;
    }

    const filePath = URI.parse(uri).fsPath;

    let ast: SourceUnit | null = null;
    let diagnostics: Diagnostic[] = [];
    let sourceFileMap = new Map<number, string>();

    // Pre-read existing AST before forge potentially wipes it on failure
    const preRead = readAstFromDisk(project, filePath);
    ast = preRead?.ast ?? null;
    sourceFileMap = preRead?.sourceFileMap ?? new Map();

    // Run forge build
    let forgeSucceeded = false;
    try {
      const { stdout, stderr } = await execFileAsync('forge', ['build', '--ast'], {
        cwd: project.root,
        timeout: 30000,
        encoding: 'utf-8',
        maxBuffer: 50 * 1024 * 1024,
      });
      // Quick text-based diagnostics from stderr
      diagnostics = parseForgeOutput(stdout, stderr);
      forgeSucceeded = true;
    } catch (error: any) {
      if (error.stderr || error.stdout) {
        diagnostics = parseForgeOutput(error.stdout || '', error.stderr || '');
      }
    }

    // If forge succeeded, re-read AST, rebuild sourceFileMap, index files, and get structured diagnostics
    if (forgeSucceeded) {
      const freshRead = readAstFromDisk(project, filePath);
      if (freshRead?.ast) ast = freshRead.ast;
      if (freshRead?.sourceFileMap && freshRead.sourceFileMap.size > 0) {
        sourceFileMap = freshRead.sourceFileMap;
      }

      // Index all compiled files for cross-file resolution
      indexCompiledFiles(project, sourceFileMap);

      // Try to get structured diagnostics from forge's JSON output (more precise ranges)
      const jsonDiagnostics = readForgeJsonDiagnostics(project);
      if (jsonDiagnostics.length > 0) {
        diagnostics = jsonDiagnostics;
      }
    }

    const result: CompileResult = {
      uri,
      diagnostics,
      ast,
      timestamp: Date.now(),
      sourceFileMap,
    };

    this.cache.set(uri, content, result);

    // Update dependency graph from this file's imports
    if (ast) {
      this.updateDependencies(uri, ast, sourceFileMap);
    }

    return result;
  }

  async compileWithDebounce(
    uri: string,
    content: string,
    callback: (diagnostics: Diagnostic[]) => void
  ): Promise<void> {
    const existingTimer = this.debounceTimers.get(uri);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    const timer = setTimeout(async () => {
      this.debounceTimers.delete(uri);
      const result = await this.compile(uri, content);
      callback(result?.diagnostics ?? []);

      // Recompile dependent files
      const dependents = this.inverseDeps.get(uri);
      if (dependents) {
        for (const depUri of dependents) {
          if (depUri === uri) continue;
          const depResult = this.cache.getByUri(depUri);
          if (depResult) {
            // Invalidate cache so next compile re-runs
            this.cache.invalidate(depUri);
            // Recompile (forge already ran, just re-read AST)
            const recompiled = await this.compile(depUri, depResult.ast ? '' : '');
            // Push diagnostics for dependent files
            callback(recompiled?.diagnostics ?? []);
          }
        }
      }
    }, 500);

    this.debounceTimers.set(uri, timer);
  }

  private updateDependencies(
    uri: string,
    ast: AstNode,
    sourceFileMap: Map<number, string>
  ): void {
    const imports = findImports(ast);
    const importedUris = new Set<string>();

    for (const imp of imports) {
      if (!isImportDirective(imp)) continue;
      const importPath = (imp as ImportDirective).file;
      if (!importPath) continue;

      // Try to resolve the import to a file URI
      const resolved = this.resolveImportToUri(uri, importPath, sourceFileMap);
      if (resolved) {
        importedUris.add(resolved);
      }
    }

    // Update inverse deps
    // First, remove old inverse deps for this file
    const oldDeps = this.dependencyGraph.get(uri);
    if (oldDeps) {
      for (const oldDep of oldDeps) {
        this.inverseDeps.get(oldDep)?.delete(uri);
      }
    }

    this.dependencyGraph.set(uri, importedUris);

    // Add new inverse deps
    for (const depUri of importedUris) {
      const inverse = this.inverseDeps.get(depUri);
      if (inverse) {
        inverse.add(uri);
      } else {
        this.inverseDeps.set(depUri, new Set([uri]));
      }
    }
  }

  private resolveImportToUri(
    fileUri: string,
    importPath: string,
    sourceFileMap: Map<number, string>
  ): string | null {
    // Simple resolution: try to find the file in the sourceFileMap
    for (const [, filePath] of sourceFileMap) {
      if (filePath.endsWith(importPath) || filePath.includes(importPath)) {
        return URI.file(filePath).toString();
      }
    }

    // Try relative to the importing file's directory
    const importingDir = path.dirname(URI.parse(fileUri).fsPath);
    const resolved = path.resolve(importingDir, importPath);
    if (fs.existsSync(resolved)) {
      return URI.file(resolved).toString();
    }

    return null;
  }

  getCachedResult(uri: string): CompileResult | undefined {
    return this.cache.getByUri(uri);
  }

  invalidate(uri: string): void {
    this.cache.invalidate(uri);
    const timer = this.debounceTimers.get(uri);
    if (timer) {
      clearTimeout(timer);
      this.debounceTimers.delete(uri);
    }
  }

  dispose(): void {
    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();
    this.cache.clear();
  }
}

interface AstReadResult {
  ast: SourceUnit | null;
  sourceFileMap: Map<number, string>;
}

function readAstFromDisk(project: FoundryProject, filePath: string): AstReadResult {
  const sourceFileMap = new Map<number, string>();
  let ast: SourceUnit | null = null;

  try {
    const outDir = path.join(project.root, project.config.out);
    if (!fs.existsSync(outDir)) return { ast: null, sourceFileMap };

    // Read all artifact directories to build sourceFileMap
    const entries = fs.readdirSync(outDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const artifactDir = path.join(outDir, entry.name);
      const jsonFiles = fs.readdirSync(artifactDir).filter((f) => f.endsWith('.json'));
      if (jsonFiles.length === 0) continue;

      try {
        const artifact = JSON.parse(fs.readFileSync(path.join(artifactDir, jsonFiles[0]), 'utf-8'));
        if (artifact.ast?.src) {
          // Extract file index from the first src field: "start:length:fileIndex"
          const srcParts = artifact.ast.src.split(':');
          if (srcParts.length >= 3) {
            const fileIndex = parseInt(srcParts[2], 10);
            if (!isNaN(fileIndex) && !sourceFileMap.has(fileIndex)) {
              // Resolve the full file path from the artifact directory name
              // Artifact dirs are named after the source file basename
              // We need to find the actual source file
              const sourcePath = findSourceFile(project, entry.name);
              if (sourcePath) {
                sourceFileMap.set(fileIndex, sourcePath);
              }
            }
          }
        }
      } catch {
        // Skip malformed artifacts
      }
    }

    // Read the specific file's AST
    const sourceOutDir = path.join(outDir, path.basename(filePath));
    if (fs.existsSync(sourceOutDir)) {
      const artifacts = fs.readdirSync(sourceOutDir).filter((f) => f.endsWith('.json'));
      if (artifacts.length > 0) {
        const artifact = JSON.parse(fs.readFileSync(path.join(sourceOutDir, artifacts[0]), 'utf-8'));
        ast = artifact.ast || null;
      }
    }
  } catch {
    // Ignore errors
  }

  return { ast, sourceFileMap };
}

function findSourceFile(project: FoundryProject, artifactName: string): string | null {
  // artifactName is like "Contract.sol" — find the actual source file
  const searchDirs = [
    path.join(project.root, project.config.src),
    ...project.config.libs.map((lib) => path.join(project.root, lib)),
  ];

  for (const dir of searchDirs) {
    const filePath = path.join(dir, artifactName);
    if (fs.existsSync(filePath)) {
      return filePath;
    }
  }

  return null;
}

function readForgeJsonDiagnostics(project: FoundryProject): Diagnostic[] {
  try {
    const outDir = path.join(project.root, project.config.out);
    if (!fs.existsSync(outDir)) return [];

    // Forge writes solc output as JSON in the output directory
    // Look for any artifact that contains an "errors" array
    const entries = fs.readdirSync(outDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const artifactDir = path.join(outDir, entry.name);
      const jsonFiles = fs.readdirSync(artifactDir).filter((f) => f.endsWith('.json'));
      if (jsonFiles.length === 0) continue;

      try {
        const artifact = JSON.parse(
          fs.readFileSync(path.join(artifactDir, jsonFiles[0]), 'utf-8')
        );

        // Check if this artifact has solc errors
        if (artifact.errors && Array.isArray(artifact.errors)) {
          const diags = parseDiagnostics(
            { errors: artifact.errors },
            project.root
          );
          if (diags.length > 0) return diags;
        }
      } catch {
        // Skip malformed artifacts
      }
    }
  } catch {
    // Ignore errors
  }

  return [];
}

function indexCompiledFiles(
  project: FoundryProject,
  sourceFileMap: Map<number, string>
): void {
  try {
    const outDir = path.join(project.root, project.config.out);
    if (!fs.existsSync(outDir)) return;

    globalIndex.clear();

    const entries = fs.readdirSync(outDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const artifactDir = path.join(outDir, entry.name);
      const jsonFiles = fs.readdirSync(artifactDir).filter((f) => f.endsWith('.json'));
      if (jsonFiles.length === 0) continue;

      try {
        const artifact = JSON.parse(
          fs.readFileSync(path.join(artifactDir, jsonFiles[0]), 'utf-8')
        );
        if (artifact.ast) {
          // Resolve the source file path
          const filePath = findSourceFile(project, entry.name);
          if (filePath) {
            globalIndex.indexFile(filePath, artifact.ast);
          }
        }
      } catch {
        // Skip malformed artifacts
      }
    }
  } catch {
    // Ignore errors
  }
}

function parseForgeOutput(stdout: string, stderr: string): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const output = stderr || stdout;
  const lines = output.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Match "Error (CODE): message" or "error: message"
    const errMatch = line.match(/^Error\s*\((\w+)\)\s*:\s*(.+)/i);
    const warnMatch = line.match(/^warning\[(\w+)\]\s*:\s*(.+)/i);

    if (errMatch || warnMatch) {
      const severity = errMatch ? DiagnosticSeverity.Error : DiagnosticSeverity.Warning;
      const code = (errMatch || warnMatch)![1];
      const message = (errMatch || warnMatch)![2];

      // Look for "--> file:line:col" on this line or next few lines
      for (let j = i; j < Math.min(i + 5, lines.length); j++) {
        const locMatch = lines[j].match(/-->\s+(\S+):(\d+):(\d+)/);
        if (locMatch) {
          const lineNum = parseInt(locMatch[2], 10) - 1;
          const colNum = parseInt(locMatch[3], 10) - 1;

          // Try to find the end of the error span on subsequent lines
          let endLine = lineNum;
          let endCol = colNum + 1;
          for (let k = j + 1; k < Math.min(j + 3, lines.length); k++) {
            const spanMatch = lines[k].match(/^\s*\|\s*\^+/);
            if (spanMatch) {
              endLine = lineNum + (k - j);
              endCol = spanMatch[0].length - spanMatch[0].indexOf('^');
              break;
            }
          }

          diagnostics.push({
            severity,
            range: {
              start: { line: lineNum, character: colNum },
              end: { line: endLine, character: endCol },
            },
            message,
            source: 'solc',
            code,
          });
          break;
        }
      }
    }
  }

  return diagnostics;
}

export const compilerManager = new CompilerManager();
