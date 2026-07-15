import * as fs from 'fs';
import {
  AstNode,
  isContractDefinition,
  isFunctionDefinition,
  isStateVariableDeclaration,
  isEventDefinition,
  isErrorDefinition,
  isModifierDefinition,
  isImportDirective,
} from './ast/types';
import { walkAst } from './ast/traversal';
import { globalIndex } from './indexer';

// ─── File I/O ───

export function readFileContent(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, 'utf-8');
  } catch {
    return null;
  }
}

export async function readFileContentAsync(filePath: string): Promise<string | null> {
  try {
    return await fs.promises.readFile(filePath, 'utf-8');
  } catch {
    return null;
  }
}

// ─── AST Helpers ───

export function findNodeById(ast: AstNode, id: number): AstNode | null {
  let found: AstNode | null = null;
  walkAst(ast, (node) => {
    if (found) return false;
    if (node.id === id) { found = node; return false; }
    return true;
  });
  return found;
}

export function extractNatSpec(node: AstNode): string {
  const doc = node.documentation as
    | { nodeType?: string; text?: string }
    | undefined;
  if (!doc?.text) return '';

  const lines = doc.text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

  const parts: string[] = [];
  for (const line of lines) {
    if (line.startsWith('@notice')) {
      parts.push(line.replace('@notice', '').trim());
    } else if (line.startsWith('@dev')) {
      parts.push(line.replace('@dev', '').trim());
    } else if (line.startsWith('@param')) {
      parts.push(line);
    } else if (line.startsWith('@return')) {
      parts.push(line);
    } else if (line.startsWith('@title')) {
      parts.push(line.replace('@title', '').trim());
    } else if (line.startsWith('@author')) {
      parts.push(line.replace('@author', '').trim());
    } else {
      parts.push(line);
    }
  }

  return parts.join('\n');
}

/**
 * Resolve `@inheritdoc ContractName` by fetching the documentation from the
 * parent contract/interface via GlobalIndex.  Falls back to the raw
 * `extractNatSpec` output when resolution is not possible.
 *
 * When `@inheritdoc` is found, the corresponding member (function, variable,
 * event, …) is looked up in the referenced contract and its NatSpec replaces
 * the `@inheritdoc` line.  Any additional local tags (e.g. `@dev`) are kept.
 */
export function resolveNatSpec(node: AstNode): string {
  const rawDocs = extractNatSpec(node);
  if (!rawDocs) return '';

  // Only attempt resolution when an @inheritdoc tag is present
  if (!rawDocs.includes('@inheritdoc')) return rawDocs;

  const functionName = node.name;
  if (!functionName) return rawDocs;

  // Extract all @inheritdoc ContractName tags (there may be multiple)
  const inheritRegex = /@inheritdoc\s+(\w+)/g;
  let result = rawDocs;
  let match: RegExpExecArray | null;

  while ((match = inheritRegex.exec(rawDocs)) !== null) {
    const contractName = match[1];
    const resolved = resolveInheritedDocs(contractName, functionName);
    if (resolved) {
      result = result.replace(match[0], resolved);
    }
  }

  return result;
}

/**
 * Look up `contractName` in GlobalIndex and find a member named
 * `memberName` inside it.  Returns its formatted NatSpec or null.
 */
function resolveInheritedDocs(contractName: string, memberName: string): string | null {
  // Search both contracts and interfaces
  const entries = globalIndex.findByName(contractName);
  for (const entry of entries) {
    if (
      !isContractDefinition(entry.node) &&
      entry.kind !== 'contract' &&
      entry.kind !== 'interface' &&
      entry.kind !== 'library'
    ) {
      continue;
    }

    const member = findMemberByName(entry.node, memberName);
    if (member) {
      return extractNatSpec(member);
    }
  }

  return null;
}

/**
 * Walk a contract node's children to find a member (function, variable,
 * event, error, modifier) by name.
 */
function findMemberByName(contractNode: AstNode, memberName: string): AstNode | null {
  if (!contractNode.nodes) return null;

  for (const child of contractNode.nodes) {
    if (child.name !== memberName) continue;
    if (
      isFunctionDefinition(child) ||
      isStateVariableDeclaration(child) ||
      isEventDefinition(child) ||
      isErrorDefinition(child) ||
      isModifierDefinition(child)
    ) {
      return child;
    }
  }

  return null;
}

export function extractTypeName(node: AstNode): string {
  if (!node) return 'unknown';
  if (node.nodeType === 'ElementaryTypeName') return node.name!;
  if (node.nodeType === 'UserDefinedTypeName') return node.name ?? (node as any).pathNode?.name ?? 'unknown';
  if (node.nodeType === 'Mapping') {
    const key = extractTypeName(node.keyType as AstNode);
    const value = extractTypeName(node.valueType as AstNode);
    return `mapping(${key} => ${value})`;
  }
  if (node.nodeType === 'ArrayTypeName') {
    const base = extractTypeName(node.baseType as AstNode);
    return `${base}[]`;
  }
  const typeDesc = node.typeDescriptions as { typeString?: string } | undefined;
  return typeDesc?.typeString ?? 'unknown';
}

export function findImportForSymbol(ast: AstNode, symbolName: string): string | null {
  let result: string | null = null;

  walkAst(ast, (node) => {
    if (result) return false;
    if (isImportDirective(node) && node.symbolAliases) {
      for (const alias of node.symbolAliases) {
        const foreign = alias.foreign as unknown as { name?: string };
        if (foreign?.name === symbolName) {
          result = node.file || null;
          return false;
        }
      }
    }
    return true;
  });

  return result;
}
