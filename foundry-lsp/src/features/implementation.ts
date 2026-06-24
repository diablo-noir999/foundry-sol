import { Definition, Location, Position, Range } from 'vscode-languageserver';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { URI } from 'vscode-uri';
import {
  AstNode,
  ContractDefinition,
  FunctionDefinition,
  isContractDefinition,
  isFunctionDefinition,
} from '../ast/types';
import { findNodeAtPosition, srcToRange, walkAst } from '../ast/traversal';
import { CompileResult } from '../compiler/cache';
import { globalIndex } from '../indexer';

export function provideImplementation(
  ast: AstNode,
  document: TextDocument,
  position: Position,
  compileResult: CompileResult
): Definition | null {
  const content = document.getText();
  const node = findNodeAtPosition(ast, content, position);
  if (!node) return null;

  const results: Location[] = [];

  // From a contract/interface: find all contracts that inherit from it
  if (isContractDefinition(node)) {
    const contractName = node.name;
    if (!contractName) return null;

    // Search all indexed contracts for ones that inherit from this contract
    const allContracts = globalIndex.findByKind('contract')
      .concat(globalIndex.findByKind('interface'))
      .concat(globalIndex.findByKind('library'));

    for (const entry of allContracts) {
      if (entry.name === contractName) continue; // skip self
      if (!isContractDefinition(entry.node)) continue;

      // Check linearizedBaseContracts or baseNamePaths for inheritance
      const bases = (entry.node as any).baseNamePaths ??
                    (entry.node as any).linearizedBaseContracts ??
                    [];

      // Check if any base name matches
      const baseNames = bases.map((b: any) => b.name ?? b);
      if (baseNames.includes(contractName)) {
        if (entry.node.src) {
          const entryContent = readFileContent(entry.filePath);
          if (entryContent) {
            const range = srcToRange(entry.node.src, entryContent);
            if (range) {
              results.push(Location.create(entry.uri, range));
            }
          }
        }
      }

      // Also check inheritance by walking baseNamePaths
      const baseNameNodes = (entry.node as any).baseNamePaths ?? [];
      for (const base of baseNameNodes) {
        if (base?.name === contractName) {
          if (entry.node.src && !results.some(r => r.uri === entry.uri)) {
            const entryContent = readFileContent(entry.filePath);
            if (entryContent) {
              const range = srcToRange(entry.node.src, entryContent);
              if (range) {
                results.push(Location.create(entry.uri, range));
              }
            }
          }
          break;
        }
      }
    }
  }

  // From a function: find all overriding implementations
  if (isFunctionDefinition(node)) {
    const funcName = node.name;
    if (!funcName) return null;

    // Find all functions with the same name across the project
    const allFuncs = globalIndex.findByNameAndKind(funcName, 'function');

    for (const entry of allFuncs) {
      if (entry.uri === document.uri) continue; // skip self
      if (!isFunctionDefinition(entry.node)) continue;

      // Check if it has override specifier
      const hasOverride = (entry.node as any).overrides?.length > 0;
      if (hasOverride && entry.node.src) {
        const entryContent = readFileContent(entry.filePath);
        if (entryContent) {
          const range = srcToRange(entry.node.src, entryContent);
          if (range) {
            results.push(Location.create(entry.uri, range));
          }
        }
      }
    }
  }

  return results.length > 0 ? results : null;
}

function readFileContent(filePath: string): string | null {
  try {
    return require('fs').readFileSync(filePath, 'utf-8');
  } catch {
    return null;
  }
}
