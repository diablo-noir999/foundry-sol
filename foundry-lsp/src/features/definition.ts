import { Definition, Location, Position, Range } from 'vscode-languageserver';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { URI } from 'vscode-uri';
import * as fs from 'fs';
import * as path from 'path';
import {
  AstNode,
  FunctionDefinition,
  StateVariableDeclaration,
  ContractDefinition,
  isFunctionDefinition,
  isStateVariableDeclaration,
  isContractDefinition,
  isIdentifier,
  isMemberAccess,
  isImportDirective,
  isStructDefinition,
  isEnumDefinition,
  isEventDefinition,
  isErrorDefinition,
  isModifierDefinition,
  Identifier,
  MemberAccess,
  ImportDirective,
} from '../ast/types';
import { findNodeAtPosition, srcToRange, positionToOffset, parseSrc } from '../ast/traversal';
import { CompileResult } from '../compiler/cache';
import { FoundryProject } from '../project';
import { globalIndex } from '../indexer';
import { findNodeById, readFileContent, findImportForSymbol } from '../utils';

export async function provideDefinition(
  ast: AstNode,
  document: TextDocument,
  position: Position,
  compileResult: CompileResult,
  project: FoundryProject | undefined
): Promise<Definition | null> {
  const content = document.getText();
  const node = findNodeAtPosition(ast, content, position);
  if (!node) return null;

  const sourceFileMap = compileResult.sourceFileMap;

  // Import directive — resolve import path or named symbol
  if (isImportDirective(node)) {
    // Check if cursor is on a named import symbol
    const symbolDef = resolveImportSymbolDef(node, content, position, ast, sourceFileMap);
    if (symbolDef) return symbolDef;
    return resolveImport(node, project);
  }

  // Identifier — find referenced declaration
  if (isIdentifier(node)) {
    return resolveIdentifier(node, ast, content, project, sourceFileMap);
  }

  // MemberAccess — resolve member
  if (isMemberAccess(node)) {
    return await resolveMemberAccess(node, ast, content, project, sourceFileMap);
  }

  return null;
}

function resolveImport(
  node: ImportDirective,
  project: FoundryProject | undefined
): Location | null {
  if (!project) return null;

  const importPath = node.file;

  // Resolve through remappings
  const resolved = applyRemappings(importPath, project);

  // Try absolute path first
  if (path.isAbsolute(resolved)) {
    if (fs.existsSync(resolved)) {
      return Location.create(
        URI.file(resolved).toString(),
        Range.create(0, 0, 0, 0)
      );
    }
  }

  // Try relative to project root
  const projectPath = path.join(project.root, resolved);
  if (fs.existsSync(projectPath)) {
    return Location.create(
      URI.file(projectPath).toString(),
      Range.create(0, 0, 0, 0)
    );
  }

  // Try lib/ directories
  for (const lib of project.config.libs) {
    const libPath = path.join(project.root, lib, resolved);
    if (fs.existsSync(libPath)) {
      return Location.create(
        URI.file(libPath).toString(),
        Range.create(0, 0, 0, 0)
      );
    }
  }

  // Try src/ directory
  const srcPath = path.join(project.root, project.config.src, resolved);
  if (fs.existsSync(srcPath)) {
    return Location.create(
      URI.file(srcPath).toString(),
      Range.create(0, 0, 0, 0)
    );
  }

  return null;
}

function resolveIdentifier(
  node: Identifier,
  ast: AstNode,
  content: string,
  project: FoundryProject | undefined,
  sourceFileMap: Map<number, string>
): Location | null {
  // Use referencedDeclaration if available
  if (node.referencedDeclaration !== undefined) {
    const def = findNodeById(ast, node.referencedDeclaration);
    if (def?.src) {
      const range = srcToRange(def.src, content);
      if (range) {
        const uri = documentUri(def, sourceFileMap);
        return Location.create(uri, range);
      }
    }
  }

  // Fallback: search by name in current file
  const localDef = findDefinitionByNameLocation(ast, node.name!, content, sourceFileMap);
  if (localDef) return localDef;

  // Last resort: check if this is a named import symbol — navigate to imported file
  if (project && node.name) {
    const importPath = findImportForSymbol(ast, node.name);
    if (importPath) {
      return resolveImportPath(importPath, project);
    }
  }

  return null;
}

async function resolveMemberAccess(
  node: MemberAccess,
  ast: AstNode,
  content: string,
  project: FoundryProject | undefined,
  sourceFileMap: Map<number, string>
): Promise<Location | null> {
  const memberName = node.memberName;

  // First try referencedDeclaration (cross-file resolution)
  const refId = (node as any).referencedDeclaration;
  if (typeof refId === 'number' && refId !== -1) {
    const def = findNodeById(ast, refId);
    if (def?.src) {
      const range = srcToRange(def.src, content);
      if (range) {
        const uri = documentUri(def, sourceFileMap);
        if (uri) return Location.create(uri, range);
      }
    }
  }

  // Scoped member access: ContractName.StructName / ContractName.EnumName
  // When expression is an Identifier referencing a contract/interface/library,
  // search that contract's members for the right-hand side.
  const scopedResult = resolveScopedMemberAccess(node, ast, content, sourceFileMap);
  if (scopedResult) return scopedResult;

  // Find all definitions with that name in current file
  const results: Location[] = [];

  const walk = (n: AstNode) => {
    if (
      n.name === memberName &&
      (isFunctionDefinition(n) ||
        isStateVariableDeclaration(n) ||
        isStructDefinition(n) ||
        isEnumDefinition(n) ||
        isEventDefinition(n) ||
        isErrorDefinition(n) ||
        isModifierDefinition(n))
    ) {
      if (n.src) {
        const range = srcToRange(n.src, content);
        if (range) {
          results.push(
            Location.create(documentUri(n, sourceFileMap), range)
          );
        }
      }
    }

    if (n.nodes) {
      for (const child of n.nodes) {
        walk(child);
      }
    }
  };

  walk(ast);
  if (results.length > 0) return results[0];

  // Fallback: search by name in all indexed files
  if (project) {
    const entries = globalIndex.findByName(memberName);
    for (const entry of entries) {
      if (entry.node.src) {
        const entryContent = readFileContent(entry.filePath);
        if (entryContent) {
          const range = srcToRange(entry.node.src, entryContent);
          if (range) {
            return Location.create(entry.uri, range);
          }
        }
      }
    }
  }

  return null;
}

/**
 * Resolve `ContractName.MemberName` — scoped member access.
 *
 * When a MemberAccess node's expression is an Identifier that references a
 * contract, interface, or library, we find that type definition via GlobalIndex
 * and walk its AST children to locate the member (struct, enum, event, error,
 * function, state variable, modifier).
 *
 * This handles patterns like:
 *   MyContract.MyStruct
 *   IToken.Transfer
 *   MathLib.sqrt
 */
function resolveScopedMemberAccess(
  node: MemberAccess,
  ast: AstNode,
  content: string,
  sourceFileMap: Map<number, string>
): Location | null {
  const expression = node.expression as AstNode;
  if (!expression) return null;

  // The expression must be an Identifier (e.g., the `MyContract` in `MyContract.MyStruct`)
  if (!isIdentifier(expression) || !expression.name) return null;

  const containerName = expression.name;
  const memberName = node.memberName;

  // Step 1: Find the container type (contract/interface/library) via GlobalIndex
  const containerEntries = globalIndex.findByNameAndKind(containerName, 'contract')
    .concat(globalIndex.findByNameAndKind(containerName, 'interface'))
    .concat(globalIndex.findByNameAndKind(containerName, 'library'));

  if (containerEntries.length === 0) return null;

  // Step 2: Walk the container's AST children to find the member.
  // Contract members (structs, enums, events, errors, functions, etc.)
  // are always direct children of the ContractDefinition node.
  for (const entry of containerEntries) {
    const contractNode = entry.node;
    if (!contractNode.nodes) continue;

    const memberContent = readFileContent(entry.filePath) ?? content;

    const found = findMemberInAst(contractNode.nodes, memberName);
    if (found?.src) {
      const memberRange = srcToRange(found.src, memberContent);
      if (memberRange) {
        return Location.create(entry.uri, memberRange);
      }
    }
  }

  return null;
}

/**
 * Deep-walk an AST subtree looking for a named definition node.
 * Searches all definition types that can appear as contract members.
 */
function findMemberInAst(
  nodes: AstNode[],
  memberName: string
): AstNode | null {
  for (const child of nodes) {
    if (child.name === memberName) {
      if (
        isStructDefinition(child) ||
        isEnumDefinition(child) ||
        isEventDefinition(child) ||
        isErrorDefinition(child) ||
        isFunctionDefinition(child) ||
        isStateVariableDeclaration(child) ||
        isModifierDefinition(child)
      ) {
        return child;
      }
    }

    // Recurse into children
    if (child.nodes) {
      const found = findMemberInAst(child.nodes, memberName);
      if (found) return found;
    }
  }

  return null;
}

// ─── Helpers ───

function applyRemappings(importPath: string, project: FoundryProject): string {
  // Sort remappings by prefix length (longest first) for greedy matching
  const sorted = Array.from(project.remappings.entries()).sort(
    (a, b) => b[0].length - a[0].length
  );

  for (const [prefix, target] of sorted) {
    if (importPath.startsWith(prefix)) {
      const rest = importPath.slice(prefix.length);
      return path.join(target, rest);
    }
  }

  return importPath;
}

function resolveImportSymbolDef(
  importNode: ImportDirective,
  content: string,
  position: Position,
  ast: AstNode,
  sourceFileMap: Map<number, string>
): Location | null {
  if (!importNode.symbolAliases) return null;

  const offset = positionToOffset(content, position);

  for (const alias of importNode.symbolAliases) {
    const foreign = alias.foreign as unknown as AstNode;
    if (!foreign?.src) continue;

    const parsed = parseSrc(foreign.src);
    if (!parsed) continue;

    if (offset >= parsed.start && offset <= parsed.start + parsed.length) {
      const refId = (foreign as any).referencedDeclaration;
      if (refId !== undefined) {
        const def = findNodeById(ast, refId);
        if (def?.src) {
          const range = srcToRange(def.src, content);
          if (range) {
            const uri = documentUri(def, sourceFileMap);
            return Location.create(uri, range);
          }
        }
      }
      return null;
    }
  }

  return null;
}

function resolveImportPath(importPath: string, project: FoundryProject): Location | null {
  // Resolve through remappings
  const resolved = applyRemappings(importPath, project);

  // Try relative to project root
  const projectPath = path.join(project.root, resolved);
  if (fs.existsSync(projectPath)) {
    return Location.create(URI.file(projectPath).toString(), Range.create(0, 0, 0, 0));
  }

  // Try lib/ directories
  for (const lib of project.config.libs) {
    const libPath = path.join(project.root, lib, resolved);
    if (fs.existsSync(libPath)) {
      return Location.create(URI.file(libPath).toString(), Range.create(0, 0, 0, 0));
    }
  }

  // Try src/ directory
  const srcPath = path.join(project.root, project.config.src, resolved);
  if (fs.existsSync(srcPath)) {
    return Location.create(URI.file(srcPath).toString(), Range.create(0, 0, 0, 0));
  }

  return null;
}

function findDefinitionByNameLocation(
  ast: AstNode,
  name: string,
  content: string,
  sourceFileMap: Map<number, string>
): Location | null {
  let found: AstNode | null = null;

  const walk = (node: AstNode) => {
    if (found) return;

    if (
      node.name === name &&
      (isContractDefinition(node) ||
        isFunctionDefinition(node) ||
        isStateVariableDeclaration(node) ||
        isStructDefinition(node) ||
        isEnumDefinition(node) ||
        isEventDefinition(node) ||
        isErrorDefinition(node) ||
        isModifierDefinition(node))
    ) {
      found = node;
      return;
    }

    if (node.nodes) {
      for (const child of node.nodes) {
        walk(child);
      }
    }
  };

  walk(ast);

  const foundNode = found as AstNode | null;
  if (foundNode?.src) {
    const range = srcToRange(foundNode.src, content);
    if (range) {
      const uri = documentUri(foundNode, sourceFileMap);
      return Location.create(uri, range);
    }
  }

  return null;
}

function documentUri(node: AstNode, sourceFileMap: Map<number, string>): string {
  if (!node.src) return '';

  // Parse the src field: "start:length:fileIndex"
  const parts = node.src.split(':');
  if (parts.length < 3) return '';

  const fileIndex = parseInt(parts[2], 10);
  if (isNaN(fileIndex)) return '';

  const filePath = sourceFileMap.get(fileIndex);
  if (filePath) {
    return URI.file(filePath).toString();
  }

  return '';
}
