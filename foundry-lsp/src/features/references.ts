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

  const defId = resolveDefinitionId(node, ast);
  if (defId === undefined) return [];

  const results: Location[] = [];
  const uri = document.uri;

  // Search in the current file
  collectReferencesInAst(ast, content, uri, defId, results);

  // Search in all indexed files via globalIndex
  const indexedEntries = globalIndex.searchByName(node.name ?? '');
  for (const entry of indexedEntries) {
    if (entry.uri === uri) continue;
    const fileContent = readFileContent(entry.filePath);
    if (!fileContent) continue;
    collectReferencesInAst(entry.node, fileContent, entry.uri, defId, results);
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
