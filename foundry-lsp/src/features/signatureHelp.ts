import {
  SignatureHelp,
  SignatureInformation,
  ParameterInformation,
  Position,
} from 'vscode-languageserver';
import { TextDocument } from 'vscode-languageserver-textdocument';
import {
  AstNode,
  isFunctionDefinition,
  isFunctionCall,
  isModifierDefinition,
  isEventDefinition,
  isErrorDefinition,
} from '../ast/types';
import { findNodeAtPosition, walkAst, parseSrc, offsetToPosition, positionToOffset } from '../ast/traversal';
import { CompileResult } from '../compiler/cache';
import { globalIndex } from '../indexer';
import * as fs from 'fs';

export function provideSignatureHelp(
  ast: AstNode,
  document: TextDocument,
  position: Position,
  compileResult: CompileResult
): SignatureHelp | null {
  const content = document.getText();

  // Find the function call node enclosing the cursor
  const callNode = findFunctionCallAtPosition(ast, content, position);
  if (!callNode) return null;

  // Get the function name from the call expression
  const expr = (callNode as any).expression;
  if (!expr?.name) return null;

  const funcName = expr.name;

  // Find the function definition (current file or indexed)
  const funcDef = findFunctionDefinition(funcName, ast, content, compileResult);
  if (!funcDef) return null;

  // Build signature
  const sig = buildSignature(funcDef, content);
  if (!sig) return null;

  // Determine active parameter based on cursor position
  const activeParam = countCommasBeforePosition(content, position, callNode);

  return {
    signatures: [sig],
    activeSignature: 0,
    activeParameter: Math.min(activeParam, (sig.parameters?.length ?? 1) - 1),
  };
}

function findFunctionCallAtPosition(ast: AstNode, content: string, position: Position): AstNode | null {
  let found: AstNode | null = null;
  let bestRange = Infinity;

  walkAst(ast, (node) => {
    if (isFunctionCall(node) && node.src) {
      const parsed = parseSrc(node.src);
      if (parsed) {
        const pos = offsetToPosition(content, parsed.start);
        const nodeLine = pos.line;
        const cursorLine = position.line;

        // Check if cursor is within the call (same line, within src range)
        if (cursorLine >= nodeLine) {
          const nodeContent = content.substring(parsed.start, parsed.start + parsed.length);
          const openParen = nodeContent.indexOf('(');
          const closeParen = nodeContent.lastIndexOf(')');

          if (openParen >= 0 && closeParen >= 0) {
            const absOpen = parsed.start + openParen;
            const absClose = parsed.start + closeParen;
            const cursorOffset = offsetToPosition(content, positionToOffset(content, position)).line === nodeLine
              ? position.character + (position.line * 1000)
              : 0;
            const nodeStart = pos.line * 1000 + pos.character;

            if (cursorOffset >= nodeStart && cursorOffset <= (absClose * 1)) {
              const rangeSize = parsed.length;
              if (rangeSize < bestRange) {
                bestRange = rangeSize;
                found = node;
              }
            }
          }
        }
      }
    }
    return true;
  });

  return found;
}

function findFunctionDefinition(
  name: string,
  ast: AstNode,
  content: string,
  compileResult: CompileResult
): AstNode | null {
  // Search current file
  let found: AstNode | null = null;
  walkAst(ast, (node) => {
    if (found) return false;
    if (isFunctionDefinition(node) && node.name === name) {
      found = node;
      return false;
    }
    return true;
  });
  if (found) return found;

  // Search indexed files
  const entries = globalIndex.findByNameAndKind(name, 'function');
  if (entries.length > 0) {
    return entries[0].node;
  }

  // Also check modifiers and events
  const modEntries = globalIndex.findByNameAndKind(name, 'modifier');
  if (modEntries.length > 0) return modEntries[0].node;

  const evtEntries = globalIndex.findByNameAndKind(name, 'event');
  if (evtEntries.length > 0) return evtEntries[0].node;

  const errEntries = globalIndex.findByNameAndKind(name, 'error');
  if (errEntries.length > 0) return errEntries[0].node;

  return null;
}

function buildSignature(node: AstNode, content: string): SignatureInformation | null {
  const name = node.name ?? '';
  const params = extractParameters(node, content);
  const returns = extractReturns(node, content);
  const docs = extractNatSpec(node);

  const paramStr = params.map((p) => `${p.type} ${p.name}`).join(', ');
  const returnStr = returns.length > 0 ? ` returns (${returns.map((r) => `${r.type} ${r.name}`).join(', ')})` : '';

  let kind = 'function';
  if (isFunctionDefinition(node)) {
    kind = (node as any).kind || 'function';
  } else if ((node as any).nodeType === 'ModifierDefinition') {
    kind = 'modifier';
  } else if ((node as any).nodeType === 'EventDefinition') {
    kind = 'event';
  } else if ((node as any).nodeType === 'ErrorDefinition') {
    kind = 'error';
  }

  const label = `${kind} ${name}(${paramStr})${returnStr}`;

  // 11.10: Parameter label offsets for active parameter highlighting
  const paramOffsetBase = `${kind} ${name}(`.length;
  let currentOffset = paramOffsetBase;
  const parameters: ParameterInformation[] = params.map((p) => {
    const paramLabel = `${p.type} ${p.name}`;
    const start = currentOffset;
    const end = currentOffset + paramLabel.length;
    currentOffset = end + 2; // +2 for ", "
    return {
      label: [start, end] as [number, number],
      documentation: p.type,
    };
  });

  // 11.4: NatSpec documentation as markdown
  let documentation: string | undefined;
  if (docs) {
    const lines: string[] = [];
    const natSpecLines = docs.split('\n').filter(Boolean);
    for (const line of natSpecLines) {
      if (line.startsWith('@notice')) {
        lines.push(line.replace('@notice', '').trim());
      } else if (line.startsWith('@dev')) {
        lines.push('', line.replace('@dev', '**Dev:** ').trim());
      } else if (line.startsWith('@param')) {
        lines.push(line);
      } else if (line.startsWith('@return')) {
        lines.push(line);
      } else {
        lines.push(line);
      }
    }
    documentation = lines.join('\n');
  }

  return {
    label,
    documentation,
    parameters,
  };
}

function extractParameters(node: AstNode, content: string): Array<{ type: string; name: string }> {
  const params: Array<{ type: string; name: string }> = [];

  const paramList = (node as any).parameters?.parameters ?? [];
  for (const p of paramList) {
    const typeName = p.typeName?.name ?? p.typeName?.typeDescriptions?.typeString ?? 'unknown';
    const paramName = p.name ?? '';
    params.push({ type: typeName, name: paramName });
  }

  return params;
}

function extractReturns(node: AstNode, content: string): Array<{ type: string; name: string }> {
  const returns: Array<{ type: string; name: string }> = [];

  const returnParams = (node as any).returnParameters?.parameters ?? [];
  for (const p of returnParams) {
    const typeName = p.typeName?.name ?? p.typeName?.typeDescriptions?.typeString ?? 'unknown';
    const paramName = p.name ?? '';
    returns.push({ type: typeName, name: paramName });
  }

  return returns;
}

function extractNatSpec(node: AstNode): string {
  const doc = (node as any).documentation;
  if (!doc?.text) return '';
  return doc.text.split('\n').map((l: string) => l.trim()).filter(Boolean).join('\n');
}

function countCommasBeforePosition(content: string, position: Position, callNode: AstNode): number {
  if (!callNode.src) return 0;

  const parsed = parseSrc(callNode.src);
  if (!parsed) return 0;

  const openParen = content.indexOf('(', parsed.start);
  if (openParen < 0) return 0;

  // Count commas between openParen and cursor position
  const cursorOffset = position.line * 1000 + position.character;
  let count = 0;
  for (let i = openParen + 1; i < content.length; i++) {
    const ch = content[i];
    if (ch === '(') break; // nested call
    if (ch === ')') break;
    if (ch === ',') count++;
  }

  return count;
}
