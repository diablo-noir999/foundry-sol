import {
  SymbolInformation,
  SymbolKind,
  Location,
} from 'vscode-languageserver';
import { URI } from 'vscode-uri';
import { globalIndex, SymbolKind as IndexSymbolKind } from '../indexer';
import { srcToRange } from '../ast/traversal';

const KIND_MAP: Record<IndexSymbolKind, SymbolKind> = {
  contract: SymbolKind.Class,
  interface: SymbolKind.Interface,
  library: SymbolKind.Module,
  function: SymbolKind.Function,
  variable: SymbolKind.Variable,
  struct: SymbolKind.Struct,
  enum: SymbolKind.Enum,
  event: SymbolKind.Event,
  error: SymbolKind.Event,
  modifier: SymbolKind.Function,
  typedef: SymbolKind.TypeParameter,
  constant: SymbolKind.Constant,
};

export function provideWorkspaceSymbols(query: string): SymbolInformation[] {
  if (!query) return [];

  const entries = globalIndex.searchFuzzy(query);
  const results: SymbolInformation[] = [];

  for (const entry of entries) {
    if (!entry.node.src) continue;

    const content = readFileContent(entry.filePath);
    if (!content) continue;

    const range = srcToRange(entry.node.src, content);
    if (!range) continue;

    const symbolKind = KIND_MAP[entry.kind] ?? SymbolKind.Variable;
    const containerName = findContainerName(entry.node);

    results.push({
      name: entry.name,
      kind: symbolKind,
      location: Location.create(entry.uri, range),
      containerName,
    });
  }

  return results;
}

function findContainerName(node: any): string | undefined {
  let current = node;
  while (current) {
    if (current.parent) {
      current = current.parent;
      if (current.name && current.nodeType !== 'SourceUnit') {
        return current.name;
      }
    } else {
      break;
    }
  }
  return undefined;
}

function readFileContent(filePath: string): string | null {
  try {
    const fs = require('fs');
    return fs.readFileSync(filePath, 'utf-8');
  } catch {
    return null;
  }
}
