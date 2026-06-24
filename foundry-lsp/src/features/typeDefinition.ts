import { Definition, Location, Position, Range } from 'vscode-languageserver';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { URI } from 'vscode-uri';
import {
  AstNode,
  isIdentifier,
  isUserDefinedTypeName,
  isStateVariableDeclaration,
  isVariableDeclaration,
  isFunctionDefinition,
} from '../ast/types';
import { findNodeAtPosition, srcToRange, walkAst } from '../ast/traversal';
import { CompileResult } from '../compiler/cache';
import { globalIndex } from '../indexer';

export function provideTypeDefinition(
  ast: AstNode,
  document: TextDocument,
  position: Position,
  compileResult: CompileResult
): Definition | null {
  const content = document.getText();
  const node = findNodeAtPosition(ast, content, position);
  if (!node) return null;

  // Try to find the type name under cursor
  const typeName = extractTypeName(node);
  if (!typeName) return null;

  // Search for the type definition in current file
  const localDef = findTypeDefinition(ast, typeName);
  if (localDef?.src) {
    const range = srcToRange(localDef.src, content);
    if (range) {
      const uri = resolveUri(localDef, compileResult);
      return Location.create(uri, range);
    }
  }

  // Search in global index
  const indexed = globalIndex.findByNameAndKind(typeName, 'contract')
    .concat(globalIndex.findByNameAndKind(typeName, 'interface'))
    .concat(globalIndex.findByNameAndKind(typeName, 'library'))
    .concat(globalIndex.findByNameAndKind(typeName, 'struct'))
    .concat(globalIndex.findByNameAndKind(typeName, 'enum'));

  if (indexed.length > 0) {
    const entry = indexed[0];
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

  return null;
}

function extractTypeName(node: AstNode): string | null {
  // Direct user-defined type name
  if (isUserDefinedTypeName(node)) {
    return node.name ?? null;
  }

  // Identifier — try to resolve its type
  if (isIdentifier(node)) {
    // The identifier's name might be a type
    return node.name ?? null;
  }

  // State variable — extract type from typeName
  if (isStateVariableDeclaration(node)) {
    const typeName = (node as any).typeName;
    if (typeName?.name) return typeName.name;
    if (typeName?.typeDescriptions?.typeString) {
      const match = typeName.typeDescriptions.typeString.match(/contract (\w+)/);
      if (match) return match[1];
    }
  }

  // Variable declaration (function parameter, etc.)
  if (isVariableDeclaration(node)) {
    const typeName = (node as any).typeName;
    if (typeName?.name) return typeName.name;
  }

  // Function — return type
  if (isFunctionDefinition(node)) {
    const returnParams = (node as any).returnParameters;
    if (returnParams?.parameters?.length > 0) {
      const firstReturn = returnParams.parameters[0];
      if (firstReturn.typeName?.name) return firstReturn.typeName.name;
    }
  }

  return null;
}

function findTypeDefinition(ast: AstNode, typeName: string): AstNode | null {
  let found: AstNode | null = null;

  walkAst(ast, (node) => {
    if (found) return false;
    if (
      node.name === typeName &&
      (node.nodeType === 'ContractDefinition' ||
        node.nodeType === 'StructDefinition' ||
        node.nodeType === 'EnumDefinition')
    ) {
      found = node;
      return false;
    }
    return true;
  });

  return found;
}

function resolveUri(node: AstNode, compileResult: CompileResult): string {
  if (!node.src) return '';

  const parts = node.src.split(':');
  if (parts.length < 3) return '';

  const fileIndex = parseInt(parts[2], 10);
  if (isNaN(fileIndex)) return '';

  const filePath = compileResult.sourceFileMap.get(fileIndex);
  if (filePath) {
    return URI.file(filePath).toString();
  }

  return '';
}

function readFileContent(filePath: string): string | null {
  try {
    const fs = require('fs');
    return fs.readFileSync(filePath, 'utf-8');
  } catch {
    return null;
  }
}
