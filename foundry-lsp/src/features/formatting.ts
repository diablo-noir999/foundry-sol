import { Connection, TextEdit } from 'vscode-languageserver';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { spawn } from 'child_process';
import { projectManager } from '../project';

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

    child.on('error', () => {
      connection.window.showErrorMessage('Formatting failed: forge not found or unavailable');
      resolve([]);
    });

    child.stdin.write(content);
    child.stdin.end();
  });
}
