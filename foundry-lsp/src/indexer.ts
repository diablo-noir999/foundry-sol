import { URI } from 'vscode-uri';
import {
  AstNode,
  isContractDefinition,
  isFunctionDefinition,
  isStateVariableDeclaration,
  isStructDefinition,
  isEnumDefinition,
  isEventDefinition,
  isErrorDefinition,
  isModifierDefinition,
} from './ast/types';
import { walkAst } from './ast/traversal';

export type SymbolKind =
  | 'contract'
  | 'interface'
  | 'library'
  | 'function'
  | 'variable'
  | 'struct'
  | 'enum'
  | 'event'
  | 'error'
  | 'modifier'
  | 'typedef'
  | 'constant';

export interface IndexEntry {
  name: string;
  kind: SymbolKind;
  node: AstNode;
  uri: string;
  filePath: string;
  nodeId?: number;
}

export class GlobalIndex {
  private symbols = new Map<string, IndexEntry[]>();
  private fileIndex = new Map<string, IndexEntry[]>();
  private nodeMap = new Map<number, IndexEntry>();

  clear(): void {
    this.symbols.clear();
    this.fileIndex.clear();
    this.nodeMap.clear();
  }

  indexFile(filePath: string, ast: AstNode): void {
    const uri = URI.file(filePath).toString();
    const entries: IndexEntry[] = [];

    walkAst(ast, (node) => {
      let kind: SymbolKind | null = null;

      if (isContractDefinition(node)) {
        const contractKind = (node as any).contractKind;
        if (contractKind === 'interface') kind = 'interface';
        else if (contractKind === 'library') kind = 'library';
        else kind = 'contract';
      } else if (isFunctionDefinition(node)) {
        kind = 'function';
      } else if (isStateVariableDeclaration(node)) {
        kind = 'variable';
      } else if (isStructDefinition(node)) {
        kind = 'struct';
      } else if (isEnumDefinition(node)) {
        kind = 'enum';
      } else if (isEventDefinition(node)) {
        kind = 'event';
      } else if (isErrorDefinition(node)) {
        kind = 'error';
      } else if (isModifierDefinition(node)) {
        kind = 'modifier';
      } else if ((node as any).nodeType === 'UserDefinedValueTypeDefinition') {
        kind = 'typedef';
      } else if ((node as any).nodeType === 'VariableDeclaration' && (node as any).stateVariable) {
        kind = 'constant';
      }

      if (kind && node.name) {
        const entry: IndexEntry = {
          name: node.name,
          kind,
          node,
          uri,
          filePath,
          nodeId: node.id,
        };
        entries.push(entry);

        const key = node.name.toLowerCase();
        const existing = this.symbols.get(key);
        if (existing) {
          existing.push(entry);
        } else {
          this.symbols.set(key, [entry]);
        }

        if (node.id !== undefined) {
          this.nodeMap.set(node.id, entry);
        }
      }

      return true;
    });

    this.fileIndex.set(uri, entries);
  }

  findByNodeId(nodeId: number): IndexEntry | undefined {
    return this.nodeMap.get(nodeId);
  }

  findByKind(kind: SymbolKind): IndexEntry[] {
    const results: IndexEntry[] = [];
    for (const entries of this.symbols.values()) {
      for (const entry of entries) {
        if (entry.kind === kind) results.push(entry);
      }
    }
    return results;
  }

  findByName(name: string): IndexEntry[] {
    return this.symbols.get(name.toLowerCase()) ?? [];
  }

  findByNameAndKind(name: string, kind: SymbolKind): IndexEntry[] {
    return this.findByName(name).filter((e) => e.kind === kind);
  }

  searchByPrefix(prefix: string): IndexEntry[] {
    const lower = prefix.toLowerCase();
    const results: IndexEntry[] = [];
    for (const [key, entries] of this.symbols) {
      if (key.startsWith(lower)) {
        results.push(...entries);
      }
    }
    return results;
  }

  searchByName(query: string): IndexEntry[] {
    const lower = query.toLowerCase();
    const results: IndexEntry[] = [];
    for (const [key, entries] of this.symbols) {
      if (key.includes(lower)) {
        results.push(...entries);
      }
    }
    return results;
  }

  searchFuzzy(query: string): IndexEntry[] {
    const lower = query.toLowerCase();
    const words = lower.split(/\s+/).filter(Boolean);
    const results: IndexEntry[] = [];

    for (const [key, entries] of this.symbols) {
      const matches = words.every((w) => key.includes(w));
      if (matches) {
        results.push(...entries);
      }
    }
    return results;
  }

  getAllEntries(): IndexEntry[] {
    const results: IndexEntry[] = [];
    for (const entries of this.symbols.values()) {
      results.push(...entries);
    }
    return results;
  }

  getFilesForSymbol(name: string): string[] {
    const entries = this.findByName(name);
    return [...new Set(entries.map((e) => e.filePath))];
  }

  getSymbolsForFile(uri: string): IndexEntry[] {
    return this.fileIndex.get(uri) ?? [];
  }

  get size(): number {
    let count = 0;
    for (const entries of this.symbols.values()) {
      count += entries.length;
    }
    return count;
  }
}

export const globalIndex = new GlobalIndex();
