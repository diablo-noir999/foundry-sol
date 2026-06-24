import { Location, Position } from 'vscode-languageserver';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { URI } from 'vscode-uri';
import {
  AstNode,
  isIdentifier,
} from '../ast/types';
import { findNodeAtPosition, srcToRange, walkAst } from '../ast/traversal';
import { CompileResult } from '../compiler/cache';
import { globalIndex } from '../indexer';
import * as fs from 'fs';
import * as path from 'path';

export function provideReferences(
  ast: AstNode,
  document: TextDocument,
  position: Position,
  compileResult: CompileResult,
  includeDeclaration: boolean
): Location[] {
  const content = document.getText();
  const node = findNodeAtPosition(ast, content, position);
  if (!node) return [];

  const name = node.name;
  if (!name) return [];

  const defId = resolveDefinitionId(node, ast);
  if (defId === undefined) return [];

  const results: Location[] = [];
  const uri = document.uri;

  const cursorRange = (node.src && srcToRange(node.src, content)) || null;

  // If includeDeclaration and cursor is on a declaration (not an Identifier reference),
  // add the declaration itself to results
  if (includeDeclaration && cursorRange && !isIdentifier(node)) {
    results.push(Location.create(uri, cursorRange));
  }

  // Search in the current file
  collectReferencesInAst(ast, content, uri, defId, results);

  // Search in all indexed files via globalIndex using AST-level referencedDeclaration
  const fileEntries = new Map<string, typeof indexedEntries>();
  const indexedEntries = globalIndex.findByName(name);
  for (const entry of indexedEntries) {
    if (entry.uri === uri) continue;
    const existing = fileEntries.get(entry.uri);
    if (existing) {
      existing.push(entry);
    } else {
      fileEntries.set(entry.uri, [entry]);
    }
  }

  for (const [entryUri, entries] of fileEntries) {
    const filePath = entries[0].filePath;
    const entryAst = readAstForFile(filePath);
    if (!entryAst) continue;

    const fileContent = readFileContent(filePath);
    if (!fileContent) continue;

    collectReferencesInAst(entryAst, fileContent, entryUri, defId, results);
  }

  if (!includeDeclaration && cursorRange) {
    return results.filter(
      (loc) =>
        loc.uri !== uri ||
        loc.range.start.line !== cursorRange.start.line ||
        loc.range.start.character !== cursorRange.start.character
    );
  }

  return results;
}

function resolveDefinitionId(node: AstNode, ast: AstNode): number | undefined {
  if (isIdentifier(node) && node.referencedDeclaration !== undefined) {
    return node.referencedDeclaration;
  }
  if (node.id !== undefined) {
    return node.id;
  }
  if (node.name) {
    const def = findDefinitionByName(ast, node.name);
    if (def?.id !== undefined) return def.id;
  }
  return undefined;
}

function findDefinitionByName(ast: AstNode, name: string): AstNode | null {
  let found: AstNode | null = null;
  walkAst(ast, (node) => {
    if (found) return false;
    if (node.name === name && node.id !== undefined) {
      found = node;
      return false;
    }
    return true;
  });
  return found;
}

function collectReferencesInAst(
  ast: AstNode,
  content: string,
  uri: string,
  targetId: number,
  results: Location[]
): void {
  walkAst(ast, (node) => {
    if (isIdentifier(node) && node.referencedDeclaration === targetId) {
      if (node.src) {
        const range = srcToRange(node.src, content);
        if (range) {
          results.push(Location.create(uri, range));
        }
      }
    }
    return true;
  });
}

function readFileContent(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, 'utf-8');
  } catch {
    return null;
  }
}

function readAstForFile(filePath: string): AstNode | null {
  try {
    const outDir = path.join(
      path.dirname(filePath),
      '..',
      'out',
      path.basename(filePath)
    );
    if (!fs.existsSync(outDir)) {
      // Try relative to project root
      const projectRoot = findProjectRoot(filePath);
      if (!projectRoot) return null;
      const altOutDir = path.join(projectRoot, 'out', path.basename(filePath));
      if (!fs.existsSync(altOutDir)) return null;
      return readAstFromOutDir(altOutDir);
    }
    return readAstFromOutDir(outDir);
  } catch {
    return null;
  }
}

function readAstFromOutDir(outDir: string): AstNode | null {
  try {
    const files = fs.readdirSync(outDir).filter((f) => f.endsWith('.json'));
    if (files.length === 0) return null;
    const artifact = JSON.parse(fs.readFileSync(path.join(outDir, files[0]), 'utf-8'));
    return artifact.ast || null;
  } catch {
    return null;
  }
}

function findProjectRoot(filePath: string): string | null {
  let dir = path.dirname(filePath);
  while (dir) {
    if (fs.existsSync(path.join(dir, 'foundry.toml'))) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}
