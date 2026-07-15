import { Diagnostic, DiagnosticSeverity } from 'vscode-languageserver';
import { URI } from 'vscode-uri';
import { execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { projectManager, FoundryProject } from '../project';
import { CompileCache, CompileResult } from './cache';
import { SourceUnit, AstNode, isImportDirective, ImportDirective } from '../ast/types';
import { parseDiagnostics } from './diagnostics';
import { globalIndex } from '../indexer';
import { findImports } from '../ast/traversal';
import { documents } from '../documents';
import { diagnosticDeduplicate } from '../features/codeAction';

const execFileAsync = promisify(execFile);

export class CompilerManager {
  private cache = new CompileCache();
  private debounceTimers = new Map<string, NodeJS.Timeout>();
  private dependencyGraph = new Map<string, Set<string>>();
  private inverseDeps = new Map<string, Set<string>>();
  /** Per-URI counter that increments on each compile request. Used by
   *  compileWithDebounce to detect and discard stale results. */
  private validationCounters = new Map<string, number>();

  async compile(uri: string, content: string): Promise<CompileResult | null> {
    try {
      return await this._compile(uri, content);
    } catch (error) {
      console.error(`[compiler] Compilation error for ${uri}:`, error);
      return null;
    }
  }

  private async _compile(uri: string, content: string): Promise<CompileResult | null> {
    const cached = this.cache.get(uri, content);
    if (cached) {
      return cached;
    }

    let project = projectManager.getProject(uri);
    let tempDir: string | null = null;

    // If no project found, create a temporary one for out-of-project files
    if (!project) {
      const result = await this.compileOutOfProject(uri, content);
      return result;
    }

    const filePath = URI.parse(uri).fsPath;

    let ast: SourceUnit | null = null;
    let diagnostics: Diagnostic[] = [];
    let sourceFileMap = new Map<number, string>();

    // Pre-read existing AST before forge potentially wipes it on failure
    try {
      const preRead = await readAstFromDisk(project, filePath);
      ast = preRead?.ast ?? null;
      sourceFileMap = preRead?.sourceFileMap ?? new Map();
    } catch (error) {
      console.error(`[compiler] readAstFromDisk error:`, error);
    }

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
      try {
        const freshRead = await readAstFromDisk(project, filePath);
        if (freshRead?.ast) ast = freshRead.ast;
        if (freshRead?.sourceFileMap && freshRead.sourceFileMap.size > 0) {
          sourceFileMap = freshRead.sourceFileMap;
        }
      } catch (error) {
        console.error(`[compiler] readAstFromDisk (fresh) error:`, error);
      }

      // Index all compiled files for cross-file resolution
      try {
        await indexCompiledFiles(project, sourceFileMap);
      } catch (error) {
        console.error(`[compiler] indexCompiledFiles error:`, error);
      }

      // Merge structured diagnostics from forge's JSON output with text-based ones
      try {
        const jsonDiagnostics = await readForgeJsonDiagnostics(project, filePath);
        if (jsonDiagnostics.length > 0) {
          // JSON diagnostics take priority for overlapping ranges
          const seen = new Set(jsonDiagnostics.map(
            (d) => `${d.range.start.line}:${d.range.start.character}-${d.range.end.line}:${d.range.end.character}`
          ));
          const nonOverlapping = diagnostics.filter(
            (d) => !seen.has(`${d.range.start.line}:${d.range.start.character}-${d.range.end.line}:${d.range.end.character}`)
          );
          diagnostics = [...nonOverlapping, ...jsonDiagnostics];
        }
      } catch (error) {
        console.error(`[compiler] readForgeJsonDiagnostics error:`, error);
      }
    }

    // Deduplicate diagnostics: remove errors superseded by more specific ones
    // at the same source location (e.g. "abstract" blocks "override" + "visibility")
    diagnostics = diagnosticDeduplicate(diagnostics);

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

  private async compileOutOfProject(uri: string, content: string): Promise<CompileResult | null> {
    const filePath = URI.parse(uri).fsPath;
    const basename = path.basename(filePath);

    let tempDir: string | null = null;
    try {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'foundry-lsp-'));
      const srcDir = path.join(tempDir, 'src');
      fs.mkdirSync(srcDir, { recursive: true });

      fs.writeFileSync(
        path.join(tempDir, 'foundry.toml'),
        '[profile.default]\nsrc = "src"\nout = "out"\nlibs = ["lib"]\n'
      );

      fs.writeFileSync(path.join(srcDir, basename), content);

      let diagnostics: Diagnostic[] = [];
      let ast: SourceUnit | null = null;
      let sourceFileMap = new Map<number, string>();
      let forgeSucceeded = false;

      try {
        const { stdout, stderr } = await execFileAsync('forge', ['build', '--ast'], {
          cwd: tempDir,
          timeout: 30000,
          encoding: 'utf-8',
          maxBuffer: 50 * 1024 * 1024,
        });
        diagnostics = parseForgeOutput(stdout, stderr);
        forgeSucceeded = true;
      } catch (error: any) {
        if (error.stderr || error.stdout) {
          diagnostics = parseForgeOutput(error.stdout || '', error.stderr || '');
        }
      }

      // Read AST from the temp project before the temp directory is deleted
      if (forgeSucceeded && tempDir) {
        try {
          const tempProject: FoundryProject = {
            root: tempDir,
            config: { src: 'src', out: 'out', libs: ['lib'], solcVersion: null },
            remappings: new Map(),
            solFiles: new Set(),
          };
          const astRead = await readAstFromDisk(tempProject, filePath);
          if (astRead.ast) ast = astRead.ast;
          if (astRead.sourceFileMap.size > 0) sourceFileMap = astRead.sourceFileMap;
        } catch (error) {
          console.error(`[compiler] compileOutOfProject readAstFromDisk error:`, error);
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
      return result;
    } catch {
      return null;
    } finally {
      if (tempDir) {
        try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (err) {
          console.error(`[compiler] Failed to clean temp dir ${tempDir}:`, err);
        }
      }
    }
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

    // Increment validation counter — any compile currently in-flight for this
    // URI will become stale once we bump this number.
    const validationId = (this.validationCounters.get(uri) ?? 0) + 1;
    this.validationCounters.set(uri, validationId);

    const timer = setTimeout(async () => {
      this.debounceTimers.delete(uri);
      const result = await this.compile(uri, content);

      // Stale result check: if the counter has advanced since we started
      // this compile, a newer request is already in-flight. Discard these
      // results to avoid flashing outdated diagnostics.
      if (this.validationCounters.get(uri) !== validationId) {
        console.log(`[compiler] Discarding stale results for ${uri} (validationId ${validationId} ≠ ${this.validationCounters.get(uri)})`);
        return;
      }

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
            // Get actual document content; skip if document isn't open
            const depDoc = documents.get(depUri);
            if (!depDoc) continue;
            // Recompile (forge already ran, just re-read AST)
            const recompiled = await this.compile(depUri, depDoc.getText());
            // Stale check for dependent files too
            if (this.validationCounters.get(uri) !== validationId) {
              continue;
            }
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
    try {
      const imports = findImports(ast);
      const importedUris = new Set<string>();

      for (const imp of imports) {
        if (!isImportDirective(imp)) continue;
        const importPath = (imp as ImportDirective).file;
        if (!importPath) continue;

        const resolved = this.resolveImportToUri(uri, importPath, sourceFileMap);
        if (resolved) {
          importedUris.add(resolved);
        }
      }

      const oldDeps = this.dependencyGraph.get(uri);
      if (oldDeps) {
        for (const oldDep of oldDeps) {
          this.inverseDeps.get(oldDep)?.delete(uri);
        }
      }

      this.dependencyGraph.set(uri, importedUris);

      for (const depUri of importedUris) {
        const inverse = this.inverseDeps.get(depUri);
        if (inverse) {
          inverse.add(uri);
        } else {
        this.inverseDeps.set(depUri, new Set([uri]));
      }
    }
    } catch (error) {
      // Ignore dependency errors
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
    this.validationCounters.clear();
    this.cache.clear();
  }
}

interface AstReadResult {
  ast: SourceUnit | null;
  sourceFileMap: Map<number, string>;
}

async function readAstFromDisk(project: FoundryProject, filePath: string): Promise<AstReadResult> {
  const sourceFileMap = new Map<number, string>();
  let ast: SourceUnit | null = null;

  try {
    const outDir = path.join(project.root, project.config.out);
    if (!fs.existsSync(outDir)) return { ast: null, sourceFileMap };

    // Read all artifact directories to build sourceFileMap
    const entries = await fs.promises.readdir(outDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const artifactDir = path.join(outDir, entry.name);
      const jsonFiles = (await fs.promises.readdir(artifactDir)).filter((f) => f.endsWith('.json'));
      if (jsonFiles.length === 0) continue;

      try {
        const artifact = JSON.parse(await fs.promises.readFile(path.join(artifactDir, jsonFiles[0]), 'utf-8'));
        if (artifact.ast?.src) {
          // Extract file index from the first src field: "start:length:fileIndex"
          const srcParts = artifact.ast.src.split(':');
          if (srcParts.length >= 3) {
            const fileIndex = parseInt(srcParts[2], 10);
            if (!isNaN(fileIndex) && !sourceFileMap.has(fileIndex)) {
              // Resolve the full file path from the artifact directory name
              // Artifact dirs are named after the source file basename
              // We need to find the actual source file
              const sourcePath = await findSourceFile(project, entry.name);
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

    // Read the specific file's AST — try both basename and full relative path
    const basename = path.basename(filePath);
    const relPath = path.relative(project.root, filePath);
    const sourceOutDir = path.join(outDir, basename);
    const sourceOutDirRel = path.join(outDir, relPath);
    const resolvedOutDir = fs.existsSync(sourceOutDirRel) ? sourceOutDirRel : sourceOutDir;
    if (fs.existsSync(resolvedOutDir)) {
      const artifacts = (await fs.promises.readdir(resolvedOutDir)).filter((f) => f.endsWith('.json'));
      if (artifacts.length > 0) {
        const artifact = JSON.parse(await fs.promises.readFile(path.join(resolvedOutDir, artifacts[0]), 'utf-8'));
        ast = artifact.ast || null;
      }
    }
  } catch {
    // Ignore errors
  }

  return { ast, sourceFileMap };
}

async function findSourceFile(project: FoundryProject, artifactName: string): Promise<string | null> {
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

  // Search recursively in lib directories
  for (const lib of project.config.libs) {
    const libDir = path.join(project.root, lib);
    const found = await findFileRecursive(libDir, artifactName);
    if (found) return found;
  }

  // Search recursively in src directory
  const srcDir = path.join(project.root, project.config.src);
  const found = await findFileRecursive(srcDir, artifactName);
  if (found) return found;

  return null;
}

async function findFileRecursive(dir: string, fileName: string): Promise<string | null> {
  try {
    const entries = await fs.promises.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === fileName && entry.isFile()) {
        return path.join(dir, fileName);
      }
      if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules') {
        const found = await findFileRecursive(path.join(dir, entry.name), fileName);
        if (found) return found;
      }
    }
  } catch {
    // Ignore read errors
  }
  return null;
}

async function readForgeJsonDiagnostics(project: FoundryProject, filePath: string): Promise<Diagnostic[]> {
  try {
    const outDir = path.join(project.root, project.config.out);
    if (!fs.existsSync(outDir)) return [];

    const allDiagnostics: Diagnostic[] = [];
    const basename = path.basename(filePath);
    const relPath = path.relative(project.root, filePath);
    const candidateDirs = [path.join(outDir, relPath), path.join(outDir, basename)];

    for (const artifactDir of candidateDirs) {
      if (!fs.existsSync(artifactDir)) continue;
      const jsonFiles = (await fs.promises.readdir(artifactDir)).filter((f) => f.endsWith('.json'));
      if (jsonFiles.length === 0) continue;

      try {
        const artifact = JSON.parse(
          await fs.promises.readFile(path.join(artifactDir, jsonFiles[0]), 'utf-8')
        );

        if (artifact.errors && Array.isArray(artifact.errors)) {
          const diags = parseDiagnostics(
            { errors: artifact.errors },
            project.root
          );
          allDiagnostics.push(...diags);
        }
      } catch {
        // Skip malformed artifacts
      }
    }

    return allDiagnostics;
  } catch {
    // Ignore errors
  }

  return [];
}

async function indexCompiledFiles(
  project: FoundryProject,
  sourceFileMap: Map<number, string>
): Promise<void> {
  try {
    const outDir = path.join(project.root, project.config.out);
    if (!fs.existsSync(outDir)) return;

    // Collect all files that will be re-indexed
    const newFilePaths = new Set<string>();

    const entries = await fs.promises.readdir(outDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const artifactDir = path.join(outDir, entry.name);
      const jsonFiles = (await fs.promises.readdir(artifactDir)).filter((f) => f.endsWith('.json'));
      if (jsonFiles.length === 0) continue;

      try {
        const artifact = JSON.parse(
          await fs.promises.readFile(path.join(artifactDir, jsonFiles[0]), 'utf-8')
        );
        if (artifact.ast) {
          const filePath = await findSourceFile(project, entry.name);
          if (filePath) {
            newFilePaths.add(filePath);
          }
        }
      } catch {
        // Skip malformed artifacts
      }
    }

    // Remove old files that are no longer in the output
    const oldFiles = globalIndex.getIndexedFiles();
    for (const oldUri of oldFiles) {
      // Extract filePath from URI
      const oldFilePath = URI.parse(oldUri).fsPath;
      if (!newFilePaths.has(oldFilePath)) {
        globalIndex.removeFile(oldFilePath);
      }
    }

    // Index new files
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const artifactDir = path.join(outDir, entry.name);
      const jsonFiles = (await fs.promises.readdir(artifactDir)).filter((f) => f.endsWith('.json'));
      if (jsonFiles.length === 0) continue;

      try {
        const artifact = JSON.parse(
          await fs.promises.readFile(path.join(artifactDir, jsonFiles[0]), 'utf-8')
        );
        if (artifact.ast) {
          const filePath = await findSourceFile(project, entry.name);
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
      const warnMatch = line.match(/^warning\[([\w-]+)\]\s*:\s*(.+)/i);

    if (errMatch || warnMatch) {
      const severity = errMatch ? DiagnosticSeverity.Error : DiagnosticSeverity.Warning;
      const code = (errMatch || warnMatch)![1];
      const message = (errMatch || warnMatch)![2];

      // Look for location on this line or next few lines
      // Forge uses both "--> file:line:col" and "╭▸ file:line:col"
      for (let j = i; j < Math.min(i + 5, lines.length); j++) {
        const locMatch = lines[j].match(/(?:-->|╭▸)\s+(\S+):(\d+):(\d+)/);
        if (locMatch) {
          const lineNum = parseInt(locMatch[2], 10) - 1;
          const colNum = parseInt(locMatch[3], 10) - 1;

          // Try to find the end of the error span on subsequent lines
          let endLine = lineNum;
          let endCol = colNum + 1;
          for (let k = j + 1; k < Math.min(j + 3, lines.length); k++) {
            const spanMatch = lines[k].match(/^\s*[│┃]\s*\^+/);
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
