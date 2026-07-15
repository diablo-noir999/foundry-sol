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
import { findNodeAtPosition, walkAst, parseSrc, positionToOffset } from '../ast/traversal';
import { CompileResult } from '../compiler/cache';
import { globalIndex } from '../indexer';
import { extractNatSpec } from '../utils';
import * as fs from 'fs';

const BUILTINS: Record<string, SignatureInformation> = {
  require: {
    label: 'function require(bool condition, string memory reason)',
    documentation: 'Reverts the transaction with the given error message if the condition is false.',
    parameters: [
      { label: [19, 43] as [number, number], documentation: 'The condition to check' },
      { label: [45, 73] as [number, number], documentation: 'Error message if condition is false' },
    ],
  },
  assert: {
    label: 'function assert(bool condition)',
    documentation: 'Reverts the transaction with Panic error if the condition is false. Used for internal errors.',
    parameters: [
      { label: [14, 38] as [number, number], documentation: 'The condition to check' },
    ],
  },
  revert: {
    label: 'function revert(string memory reason)',
    documentation: 'Reverts the transaction with the given error message.',
    parameters: [
      { label: [17, 45] as [number, number], documentation: 'Error message' },
    ],
  },
  blockhash: {
    label: 'function blockhash(uint256 blockNumber) returns (bytes32)',
    documentation: 'Get the hash of the given block number.',
    parameters: [
      { label: [20, 41] as [number, number], documentation: 'Block number' },
    ],
  },
};

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

  // Check built-in functions first
  const builtin = BUILTINS[funcName];
  if (builtin) {
    const activeParam = countCommasBeforePosition(content, position, callNode);
    return {
      signatures: [builtin],
      activeSignature: 0,
      activeParameter: Math.min(activeParam, (builtin.parameters?.length ?? 1) - 1),
    };
  }

  // Find all function definitions with this name (handles overloads)
  const funcDefs = findAllFunctionDefinitions(funcName, ast, content, compileResult);
  if (funcDefs.length === 0) return null;

  // Build signatures for all overloads
  const signatures: SignatureInformation[] = [];
  for (const funcDef of funcDefs) {
    const sig = buildSignature(funcDef, content);
    if (sig) signatures.push(sig);
  }
  if (signatures.length === 0) return null;

  // Determine active parameter based on cursor position
  const activeParam = countCommasBeforePosition(content, position, callNode);

  // Find the best matching overload based on argument count
  // activeParam is 0-based (comma count), so arg count = activeParam + 1
  const bestIndex = findBestOverload(signatures, activeParam + 1);

  return {
    signatures,
    activeSignature: bestIndex,
    activeParameter: Math.min(activeParam, (signatures[bestIndex].parameters?.length ?? 1) - 1),
  };
}

function findFunctionCallAtPosition(ast: AstNode, content: string, position: Position): AstNode | null {
  let found: AstNode | null = null;
  let bestRange = Infinity;

  const cursorOffset = positionToOffset(content, position);

  walkAst(ast, (node) => {
    if (isFunctionCall(node) && node.src) {
      const parsed = parseSrc(node.src);
      if (parsed) {
        const nodeContent = content.substring(parsed.start, parsed.start + parsed.length);
        const openParen = nodeContent.indexOf('(');
        const closeParen = nodeContent.lastIndexOf(')');

        if (openParen >= 0 && closeParen >= 0) {
          const absOpen = parsed.start + openParen;
          const absClose = parsed.start + closeParen;

          if (cursorOffset >= absOpen && cursorOffset <= absClose) {
            const rangeSize = parsed.length;
            if (rangeSize < bestRange) {
              bestRange = rangeSize;
              found = node;
            }
          }
        }
      }
    }
    return true;
  });

  return found;
}

function findAllFunctionDefinitions(
  name: string,
  ast: AstNode,
  content: string,
  compileResult: CompileResult
): AstNode[] {
  const results: AstNode[] = [];

  // Search current file for all matching functions
  walkAst(ast, (node) => {
    if (isFunctionDefinition(node) && node.name === name) {
      results.push(node);
    }
    return true;
  });

  // Search indexed files for all matching functions
  const funcEntries = globalIndex.findByNameAndKind(name, 'function');
  for (const entry of funcEntries) {
    // Avoid duplicates (same node might be in both current file and index)
    if (!results.includes(entry.node)) {
      results.push(entry.node);
    }
  }

  // Also check modifiers and events (these typically don't have overloads, but handle them)
  const modEntries = globalIndex.findByNameAndKind(name, 'modifier');
  for (const entry of modEntries) {
    if (!results.includes(entry.node)) {
      results.push(entry.node);
    }
  }

  const evtEntries = globalIndex.findByNameAndKind(name, 'event');
  for (const entry of evtEntries) {
    if (!results.includes(entry.node)) {
      results.push(entry.node);
    }
  }

  const errEntries = globalIndex.findByNameAndKind(name, 'error');
  for (const entry of errEntries) {
    if (!results.includes(entry.node)) {
      results.push(entry.node);
    }
  }

  return results;
}

/**
 * Find the best matching overload based on argument count.
 * Returns the index of the best matching signature.
 */
function findBestOverload(signatures: SignatureInformation[], argCount: number): number {
  if (signatures.length === 0) return 0;
  if (signatures.length === 1) return 0;

  // Try to find an exact match first
  for (let i = 0; i < signatures.length; i++) {
    const paramCount = signatures[i].parameters?.length ?? 0;
    if (paramCount === argCount) {
      return i;
    }
  }

  // No exact match - find the closest one
  // Prefer overloads with more parameters (they're typically the more specific ones)
  let bestIndex = 0;
  let bestDiff = Infinity;

  for (let i = 0; i < signatures.length; i++) {
    const paramCount = signatures[i].parameters?.length ?? 0;
    const diff = Math.abs(paramCount - argCount);

    if (diff < bestDiff || (diff === bestDiff && paramCount > (signatures[bestIndex].parameters?.length ?? 0))) {
      bestDiff = diff;
      bestIndex = i;
    }
  }

  return bestIndex;
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
  const documentation = docs || undefined;

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

function countCommasBeforePosition(content: string, position: Position, callNode: AstNode): number {
  if (!callNode.src) return 0;

  const parsed = parseSrc(callNode.src);
  if (!parsed) return 0;

  const openParen = content.indexOf('(', parsed.start);
  if (openParen < 0) return 0;

  const cursorOffset = positionToOffset(content, position);
  let count = 0;
  for (let i = openParen + 1; i < content.length && i < cursorOffset; i++) {
    const ch = content[i];
    if (ch === '(') break;
    if (ch === ')') break;
    if (ch === ',') count++;
  }

  return count;
}
