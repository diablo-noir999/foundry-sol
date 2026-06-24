import { Diagnostic, DiagnosticSeverity, Range } from 'vscode-languageserver';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

interface SolhintWarning {
  line: number;
  column: number;
  severity: number;
  message: string;
  ruleId: string;
  filePath: string;
}

export class SolhintLinter {
  private debounceTimers = new Map<string, NodeJS.Timeout>();

  lint(
    uri: string,
    filePath: string,
    content: string,
    callback: (diagnostics: Diagnostic[]) => void
  ): void {
    const existing = this.debounceTimers.get(uri);
    if (existing) clearTimeout(existing);

    const timer = setTimeout(() => {
      this.debounceTimers.delete(uri);
      this.runSolhint(uri, filePath, content, callback);
    }, 800);

    this.debounceTimers.set(uri, timer);
  }

  private runSolhint(
    uri: string,
    filePath: string,
    content: string,
    callback: (diagnostics: Diagnostic[]) => void
  ): void {
    const projectRoot = path.dirname(filePath);

    // Write content to a temp file for solhint
    const tmpFile = filePath + '.solhint-tmp';
    try {
      fs.writeFileSync(tmpFile, content, 'utf-8');
    } catch {
      callback([]);
      return;
    }

    const proc = spawn('npx', ['solhint', '--formatter', 'json', tmpFile], {
      cwd: projectRoot,
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 10000,
      env: { ...process.env, NO_COLOR: '1' },
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (data: Buffer) => {
      stdout += data.toString();
    });

    proc.stderr.on('data', (data: Buffer) => {
      stderr += data.toString();
    });

    proc.on('close', () => {
      try {
        fs.unlinkSync(tmpFile);
      } catch {}

      try {
        const results: SolhintWarning[] = JSON.parse(stdout);
        const diagnostics = results
          .filter((w) => w.filePath === tmpFile || w.filePath === path.basename(tmpFile))
          .map((w) => this.convertWarning(w, content));
        callback(diagnostics);
      } catch {
        callback([]);
      }
    });

    proc.on('error', () => {
      try { fs.unlinkSync(tmpFile); } catch {}
      callback([]);
    });
  }

  private convertWarning(warning: SolhintWarning, content: string): Diagnostic {
    const line = Math.max(0, warning.line - 1);
    const col = Math.max(0, warning.column - 1);

    // Try to find the end of the line
    const lines = content.split('\n');
    const endCol = lines[line] ? lines[line].length : col + 1;

    const severity =
      warning.severity === 2
        ? DiagnosticSeverity.Error
        : warning.severity === 1
        ? DiagnosticSeverity.Warning
        : DiagnosticSeverity.Information;

    return {
      severity,
      range: {
        start: { line, character: col },
        end: { line, character: endCol },
      },
      message: warning.message,
      source: 'solhint',
      code: warning.ruleId,
    };
  }

  dispose(): void {
    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();
  }
}

export const solhintLinter = new SolhintLinter();
