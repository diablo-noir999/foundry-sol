import { createHash } from 'crypto';
import { Diagnostic } from 'vscode-languageserver';
import { SourceUnit } from '../ast/types';

export interface CompileResult {
  uri: string;
  diagnostics: Diagnostic[];
  ast: SourceUnit | null;
  timestamp: number;
  sourceFileMap: Map<number, string>;
}

interface CacheEntry {
  hash: string;
  result: CompileResult;
}

export class CompileCache {
  private cache = new Map<string, CacheEntry>();

  get(uri: string, content: string): CompileResult | undefined {
    const hash = this.hashContent(content);
    const entry = this.cache.get(uri);

    if (entry && entry.hash === hash) {
      return entry.result;
    }

    return undefined;
  }

  set(uri: string, content: string, result: CompileResult): void {
    const hash = this.hashContent(content);
    const existing = this.cache.get(uri);

    // Preserve AST from a previous successful compilation if the new result lost it
    // (e.g. transient solc errors that don't affect the AST we already have)
    if (existing && existing.hash === hash && existing.result.ast && !result.ast) {
      result.ast = existing.result.ast;
    }

    // Preserve sourceFileMap from previous compilation
    if (existing && existing.hash === hash && existing.result.sourceFileMap.size > 0 && result.sourceFileMap.size === 0) {
      result.sourceFileMap = existing.result.sourceFileMap;
    }

    this.cache.set(uri, { hash, result });
  }

  invalidate(uri: string): void {
    this.cache.delete(uri);
  }

  clear(): void {
    this.cache.clear();
  }

  getByUri(uri: string): CompileResult | undefined {
    const entry = this.cache.get(uri);
    return entry?.result;
  }

  private hashContent(content: string): string {
    return createHash('sha256').update(content).digest('hex');
  }
}