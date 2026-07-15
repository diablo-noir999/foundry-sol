import { Connection, TextEdit } from 'vscode-languageserver';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { spawn } from 'child_process';
import { projectManager } from '../project';

/**
 * Simple indentation-based fallback formatter for when forge fmt is unavailable.
 * Preserves existing indentation, fixes brace placement, and strips trailing whitespace.
 */
function fallbackFormat(content: string): string {
  const lines = content.split('\n');
  const formatted: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];

    // Strip trailing whitespace
    line = line.replace(/\s+$/, '');

    // Fix opening brace on its own line — move it to end of previous line
    // Pattern: a line that is only whitespace + '{'
    const braceMatch = line.match(/^(\s*)\{\s*$/);
    if (braceMatch && formatted.length > 0) {
      const prevLine = formatted[formatted.length - 1];
      // Only merge if prev line doesn't already end with '{' or ';'
      if (!prevLine.endsWith('{') && !prevLine.endsWith(';')) {
        formatted[formatted.length - 1] = prevLine + ' {';
        continue;
      }
    }

    formatted.push(line);
  }

  return formatted.join('\n');
}

export async function provideFormatting(
  document: TextDocument,
  connection: Connection
): Promise<TextEdit[]> {
  const content = document.getText();
  const uri = document.uri;
  const project = projectManager.getProject(uri);

  if (!project) {
    return [];
  }

  return new Promise((resolve) => {
    const child = spawn('forge', ['fmt', '-'], {
      cwd: project.root,
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 10000,
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (data: Buffer) => {
      stdout += data.toString();
    });

    child.stderr.on('data', (data: Buffer) => {
      stderr += data.toString();
    });

    child.on('close', (code) => {
      if (code === 0 && stdout && stdout !== content) {
        const lastLine = document.lineCount - 1;
        const lastLineStart = content.lastIndexOf('\n', content.length - 2) + 1;
        const lastLineLength = content.length - lastLineStart;

        resolve([
          TextEdit.replace(
            {
              start: { line: 0, character: 0 },
              end: { line: lastLine, character: lastLineLength },
            },
            stdout
          ),
        ]);
      } else if (code !== 0) {
        connection.window.showErrorMessage(`Formatting failed: ${stderr || 'forge exited with code ' + code}`);
        resolve([]);
      } else {
        resolve([]);
      }
    });

    // Forge not available — use fallback formatter
    child.on('error', () => {
      const formatted = fallbackFormat(content);
      if (formatted !== content) {
        const lastLine = document.lineCount - 1;
        const lastLineStart = content.lastIndexOf('\n', content.length - 2) + 1;
        const lastLineLength = content.length - lastLineStart;

        resolve([
          TextEdit.replace(
            {
              start: { line: 0, character: 0 },
              end: { line: lastLine, character: lastLineLength },
            },
            formatted
          ),
        ]);
      } else {
        resolve([]);
      }
    });

    child.stdin.write(content);
    child.stdin.end();
  });
}
