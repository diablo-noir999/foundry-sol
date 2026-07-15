import { Position, Range } from 'vscode-languageserver';
import * as crypto from 'crypto';
import { AstNode } from './types';

// ─── LineOffsetTable: O(log n) offset↔position conversion ───

export interface LineOffsetTable {
  /** Byte offset where each line starts */
  lineStarts: number[];
  /** Content hash for invalidation */
  contentHash: string;
}

/** Build a line-start-offset table from document content. O(n) once. */
export function buildLineOffsetTable(content: string): LineOffsetTable {
  const lineStarts: number[] = [0];
  let byteOffset = 0;
  for (let i = 0; i < content.length; i++) {
    const char = content[i];
    const charBytes = Buffer.byteLength(char, 'utf-8');
    byteOffset += charBytes;
    if (char === '\n') {
      lineStarts.push(byteOffset);
    }
  }
  const contentHash = crypto.createHash('md5').update(content).digest('hex');
  return { lineStarts, contentHash };
}

/** Binary search for the line containing a byte offset. O(log n). */
function findLineForOffset(lineStarts: number[], byteOffset: number): number {
  let lo = 0;
  let hi = lineStarts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (lineStarts[mid] <= byteOffset) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** Get a single line's content from full content using line start offsets. */
function getLineContent(content: string, lineStarts: number[], line: number): string {
  const start = lineStarts[line];
  const end = line + 1 < lineStarts.length ? lineStarts[line + 1] : content.length;
  return content.substring(start, end > 0 && content[end - 1] === '\n' ? end - 1 : end);
}

/** Convert byte offset within a line to character offset. */
function byteOffsetToCharOffset(lineContent: string, byteOffset: number): number {
  let currentByte = 0;
  let charOffset = 0;
  for (let i = 0; i < lineContent.length; i++) {
    const charBytes = Buffer.byteLength(lineContent[i], 'utf-8');
    if (currentByte + charBytes > byteOffset) break;
    currentByte += charBytes;
    charOffset++;
  }
  return charOffset;
}

export function offsetToPosition(
  content: string,
  byteOffset: number,
  lineTable?: LineOffsetTable
): Position {
  if (lineTable) {
    const lineIdx = findLineForOffset(lineTable.lineStarts, byteOffset);
    const lineStart = lineTable.lineStarts[lineIdx];
    const lineContent = getLineContent(content, lineTable.lineStarts, lineIdx);
    const charOffset = byteOffsetToCharOffset(lineContent, byteOffset - lineStart);
    return { line: lineIdx, character: charOffset };
  }

  // O(n) fallback
  let line = 0;
  let character = 0;
  let currentByte = 0;

  for (let i = 0; i < content.length; i++) {
    const char = content[i];
    const charBytes = Buffer.byteLength(char, 'utf-8');

    if (currentByte + charBytes > byteOffset) {
      break;
    }

    currentByte += charBytes;

    if (char === '\n') {
      line++;
      character = 0;
    } else {
      character++;
    }
  }

  return { line, character };
}

export function srcToRange(src: string, content: string, lineTable?: LineOffsetTable): Range | null {
  const parts = src.split(':');
  if (parts.length < 2) return null;

  const start = parseInt(parts[0], 10);
  const length = parseInt(parts[1], 10);

  if (isNaN(start) || isNaN(length)) return null;

  return {
    start: offsetToPosition(content, start, lineTable),
    end: offsetToPosition(content, start + length, lineTable),
  };
}

export function parseSrc(src: string): { start: number; length: number } | null {
  const parts = src.split(':');
  if (parts.length < 2) return null;

  const start = parseInt(parts[0], 10);
  const length = parseInt(parts[1], 10);

  if (isNaN(start) || isNaN(length)) return null;

  return { start, length };
}

export function positionToOffset(
  content: string,
  position: Position,
  lineTable?: LineOffsetTable
): number {
  if (lineTable) {
    const line = Math.min(position.line, lineTable.lineStarts.length - 1);
    const lineStart = lineTable.lineStarts[line];
    const lineContent = getLineContent(content, lineTable.lineStarts, line);
    let charBytes = 0;
    for (let i = 0; i < position.character && i < lineContent.length; i++) {
      charBytes += Buffer.byteLength(lineContent[i], 'utf-8');
    }
    return lineStart + charBytes;
  }

  // O(n) fallback
  const lines = content.split('\n');
  let byteOffset = 0;

  for (let i = 0; i < position.line && i < lines.length; i++) {
    byteOffset += Buffer.byteLength(lines[i], 'utf-8') + 1; // +1 for \n
  }

  const targetLine = lines[position.line] || '';
  byteOffset += Buffer.byteLength(targetLine.substring(0, position.character), 'utf-8');

  return byteOffset;
}

export function walkAst(
  node: AstNode,
  visitor: (node: AstNode, parent: AstNode | null) => boolean | void
): void {
  walkAstInternal(node, null, visitor);
}

function walkAstInternal(
  node: AstNode,
  parent: AstNode | null,
  visitor: (node: AstNode, parent: AstNode | null) => boolean | void
): void {
  const result = visitor(node, parent);
  if (result === false) return;

  if (node.nodes) {
    for (const child of node.nodes) {
      walkAstInternal(child, node, visitor);
    }
  }

  if (nodeTypeHasChildren(node)) {
    for (const child of getChildren(node)) {
      if (child && typeof child === 'object' && 'nodeType' in child) {
        walkAstInternal(child as AstNode, node, visitor);
      }
    }
  }
}

function nodeTypeHasChildren(_node: AstNode): boolean {
  return true;
}

function getChildren(node: AstNode): AstNode[] {
  const children: AstNode[] = [];

  const pushChild = (val: unknown) => {
    if (val && typeof val === 'object' && 'nodeType' in val) {
      children.push(val as AstNode);
    }
  };

  const pushArray = (arr: unknown) => {
    if (Array.isArray(arr)) {
      for (const item of arr) {
        if (item && typeof item === 'object' && 'nodeType' in item) {
          children.push(item as AstNode);
        }
      }
    }
  };

  pushChild(node.body);
  pushChild(node.parameters);
  pushChild(node.returnParameters);
  pushChild(node.typeName);
  pushChild(node.keyType);
  pushChild(node.valueType);
  pushChild(node.baseType);
  pushChild(node.expression);
  pushChild(node.baseName);
  pushChild(node.pathNode);
  pushChild(node.subExpression);
  pushChild(node.condition);
  pushChild(node.trueBody);
  pushChild(node.falseBody);
  pushChild(node.leftHandSide);
  pushChild(node.rightHandSide);
  pushChild(node.leftExpression);
  pushChild(node.rightExpression);
  pushChild(node.baseExpression);
  pushChild(node.indexExpression);
  pushChild(node.initialValue);
  pushChild(node.eventCall);
  pushChild(node.errorCall);
  pushChild(node.block);
  pushChild(node.externalCall);
  pushChild(node.loopExpression);
  pushChild(node.trueExp);
  pushChild(node.falseExp);

  pushArray(node.arguments);
  pushArray(node.members);
  pushArray(node.baseContracts);
  pushArray(node.overrides);
  pushArray(node.statements);
  pushArray(node.modifiers);
  pushArray(node.declarations);
  pushArray(node.initializations);
  pushArray(node.clauses);
  pushArray(node.assignments);

  if (Array.isArray(node.symbolAliases)) {
    for (const alias of node.symbolAliases) {
      if (alias?.local && typeof alias.local === 'object' && 'nodeType' in alias.local) {
        children.push(alias.local as unknown as AstNode);
      }
      if (alias?.foreign && typeof alias.foreign === 'object' && 'nodeType' in alias.foreign) {
        children.push(alias.foreign as unknown as AstNode);
      }
    }
  }

  return children;
}

export function findNodeAtPosition(
  ast: AstNode,
  content: string,
  position: Position,
  lineTable?: LineOffsetTable
): AstNode | null {
  const offset = positionToOffset(content, position, lineTable);
  let best: AstNode | null = null;
  let bestLength = Infinity;

  walkAst(ast, (node) => {
    if (!node.src) return;

    const parsed = parseSrc(node.src);
    if (!parsed) return;

    if (offset >= parsed.start && offset <= parsed.start + parsed.length && parsed.length < bestLength) {
      bestLength = parsed.length;
      best = node;
    }
  });

  return best;
}

export function findNodeAtOffset(ast: AstNode, offset: number): AstNode | null {
  let best: AstNode | null = null;
  let bestLength = Infinity;

  walkAst(ast, (node) => {
    if (!node.src) return;

    const parsed = parseSrc(node.src);
    if (!parsed) return;

    if (offset >= parsed.start && offset <= parsed.start + parsed.length && parsed.length < bestLength) {
      bestLength = parsed.length;
      best = node;
    }
  });

  return best;
}

export function flattenAst(ast: AstNode): AstNode[] {
  const nodes: AstNode[] = [];

  walkAst(ast, (node) => {
    nodes.push(node);
  });

  return nodes;
}

export function findNodesByName(
  ast: AstNode,
  name: string,
  nodeType?: string
): AstNode[] {
  const results: AstNode[] = [];

  walkAst(ast, (node) => {
    if (node.name === name && (!nodeType || node.nodeType === nodeType)) {
      results.push(node);
    }
  });

  return results;
}

export function findContracts(ast: AstNode): AstNode[] {
  return findNodesByName(ast, '', 'ContractDefinition').filter(
    (n) => n.name
  );
}

export function findFunctions(ast: AstNode): AstNode[] {
  return findNodesByName(ast, '', 'FunctionDefinition').filter(
    (n) => n.name && (n as AstNode).name !== ''
  );
}

export function findStateVariables(ast: AstNode): AstNode[] {
  return findNodesByName(ast, '', 'StateVariableDeclaration');
}

export function findImports(ast: AstNode): AstNode[] {
  return findNodesByName(ast, '', 'ImportDirective');
}
