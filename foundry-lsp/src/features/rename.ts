import {
  WorkspaceEdit,
  TextEdit,
  Position,
} from 'vscode-languageserver';
import { TextDocument } from 'vscode-languageserver-textdocument';
import {
  AstNode,
  isIdentifier,
  isModifierDefinition,
} from '../ast/types';
import { findNodeAtPosition, srcToRange, walkAst, offsetToPosition, parseSrc } from '../ast/traversal';
import { CompileResult } from '../compiler/cache';
import { globalIndex } from '../indexer';
import * as fs from 'fs';

export function provideRename(
  ast: AstNode,
  document: TextDocument,
  position: Position,
  newName: string,
  compileResult: CompileResult
): WorkspaceEdit | null {
  const content = document.getText();
  const node = findNodeAtPosition(ast, content, position);
  if (!node) return null;

  const defId = resolveDefinitionId(node, ast);
  if (defId === undefined) return null;

  const defNode = findNodeById(ast, defId);
  if (!defNode?.name) return null;

  const oldName = defNode.name;
  if (oldName === newName) return null;

  const edits = new Map<string, TextEdit[]>();

  // Collect edits in the current file
  const currentEdits = collectRenamesInAst(ast, content, defId, oldName, newName);
  if (currentEdits.length > 0) {
    edits.set(document.uri, currentEdits);
  }

  // Collect edits in all other indexed files
  const indexedEntries = globalIndex.findByName(oldName);
  for (const entry of indexedEntries) {
    if (entry.uri === document.uri) continue;
    const fileContent = readFileContent(entry.filePath);
    if (!fileContent) continue;

    const fileEdits = collectRenamesInAst(entry.node, fileContent, defId, oldName, newName);
    if (fileEdits.length > 0) {
      const existing = edits.get(entry.uri);
      if (existing) {
        existing.push(...fileEdits);
      } else {
        edits.set(entry.uri, fileEdits);
      }
    }
  }

  return edits.size > 0 ? { changes: Object.fromEntries(edits) } : null;
}

function collectRenamesInAst(
  ast: AstNode,
  content: string,
  targetId: number,
  oldName: string,
  newName: string
): TextEdit[] {
  const edits: TextEdit[] = [];

  // Rename the definition itself
  walkAst(ast, (node) => {
    if (node.id === targetId && node.name === oldName && node.src) {
      const parsed = parseSrc(node.src);
      if (parsed) {
        const startOffset = parsed.start;
        const nameOffset = content.indexOf(oldName, startOffset);
        if (nameOffset >= 0) {
          const namePos = offsetToPosition(content, nameOffset);
          const nameEndPos = offsetToPosition(content, nameOffset + oldName.length);
          edits.push(TextEdit.replace({ start: namePos, end: nameEndPos }, newName));
        }
      }
    }
    return true;
  });

  // Rename all references
  walkAst(ast, (node) => {
    if (isIdentifier(node) && node.referencedDeclaration === targetId && node.src) {
      const parsed = parseSrc(node.src);
      if (parsed) {
        const nameOffset = content.indexOf(node.name!, parsed.start);
        if (nameOffset >= 0) {
          const namePos = offsetToPosition(content, nameOffset);
          const nameEndPos = offsetToPosition(content, nameOffset + node.name!.length);
          edits.push(TextEdit.replace({ start: namePos, end: nameEndPos }, newName));
        }
      }
    }
    return true;
  });

  return edits;
}

function resolveDefinitionId(node: AstNode, ast: AstNode): number | undefined {
  if (isIdentifier(node) && node.referencedDeclaration !== undefined) {
    return node.referencedDeclaration;
  }
  if (node.id !== undefined) return node.id;
  if (node.name) {
    // 11.9: If node is a modifier invocation inside a constructor, resolve to the modifier definition
    if ((node as any).nodeType === 'ModifierInvocation' || (node as any).nodeType === 'UserDefinedTypeName') {
      const def = findModifierDefinition(ast, node.name);
      if (def?.id !== undefined) return def.id;
    }
    const def = findNodeByName(ast, node.name);
    if (def?.id !== undefined) return def.id;
  }
  return undefined;
}

function findNodeById(ast: AstNode, id: number): AstNode | null {
  let found: AstNode | null = null;
  walkAst(ast, (node) => {
    if (found) return false;
    if (node.id === id) { found = node; return false; }
    return true;
  });
  return found;
}

function findNodeByName(ast: AstNode, name: string): AstNode | null {
  let found: AstNode | null = null;
  walkAst(ast, (node) => {
    if (found) return false;
    if (node.name === name && node.id !== undefined) { found = node; return false; }
    return true;
  });
  return found;
}

function findModifierDefinition(ast: AstNode, name: string): AstNode | null {
  let found: AstNode | null = null;
  walkAst(ast, (node) => {
    if (found) return false;
    if (isModifierDefinition(node) && node.name === name) {
      found = node;
      return false;
    }
    return true;
  });
  return found;
}

function readFileContent(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, 'utf-8');
  } catch {
    return null;
  }
}
