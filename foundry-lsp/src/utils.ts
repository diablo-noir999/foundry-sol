import * as fs from 'fs';
import { Position } from 'vscode-languageserver';
import { AstNode } from './ast/types';

// ─── File I/O ───

export function readFileContent(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, 'utf-8');
  } catch {
    return null;
  }
}

// ─── Position Helpers ───

export function positionToOffset(content: string, position: Position): number {
  const lines = content.split('\n');
  let offset = 0;
  for (let i = 0; i < position.line && i < lines.length; i++) {
    offset += lines[i].length + 1;
  }
  return offset + position.character;
}

// ─── AST Helpers ───

export function findNodeById(ast: AstNode, id: number): AstNode | null {
  if (ast.id === id) return ast;
  if (ast.nodes) {
    for (const child of ast.nodes) {
      const found = findNodeById(child, id);
      if (found) return found;
    }
  }
  return null;
}

export function extractNatSpec(node: AstNode): string {
  const doc = (node as any).documentation;
  if (!doc) return '';
  const text = doc.text ?? '';
  return text
    .split('\n')
    .map((line: string) => line.replace(/^\/{2,3}\s?\*?\s?/, '').trim())
    .filter((line: string) => line.length > 0)
    .join('\n');
}

export function extractTypeName(node: AstNode): string | null {
  const typeName = (node as any).typeName;
  if (!typeName) return null;

  if (typeName.name) return typeName.name;
  if (typeName.nodeType === 'ElementaryTypeName') return typeName.name;
  if (typeName.nodeType === 'UserDefinedTypeName') return typeName.name;
  if (typeName.nodeType === 'Mapping') {
    const key = extractTypeName(typeName.keyType);
    const value = extractTypeName(typeName.valueType);
    return `mapping(${key ?? '?'} => ${value ?? '?'})`;
  }
  if (typeName.nodeType === 'ArrayTypeName') {
    const base = extractTypeName(typeName.baseType);
    return base ? `${base}[]` : null;
  }
  return null;
}
