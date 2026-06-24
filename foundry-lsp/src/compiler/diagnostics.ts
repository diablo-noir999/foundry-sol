import * as fs from 'fs';
import * as path from 'path';
import { Diagnostic, DiagnosticSeverity, Range } from 'vscode-languageserver';

interface SolcError {
  component: string;
  errorCode: string;
  formattedMessage: string;
  message: string;
  severity: 'error' | 'warning';
  sourceLocation?: {
    end: number;
    file: string;
    start: number;
  };
  type: string;
}

interface SolcOutput {
  contracts?: Record<string, Record<string, unknown>>;
  errors?: SolcError[];
  sources?: Record<string, unknown>;
}

export function parseDiagnostics(
  output: SolcOutput,
  projectRoot: string
): Diagnostic[] {
  if (!output.errors) {
    return [];
  }

  return output.errors
    .filter((err) => err.severity === 'error' || err.severity === 'warning')
    .map((err) => convertDiagnostic(err, projectRoot));
}

function convertDiagnostic(
  err: SolcError,
  projectRoot: string
): Diagnostic {
  const severity =
    err.severity === 'error'
      ? DiagnosticSeverity.Error
      : DiagnosticSeverity.Warning;

  let range: Range = {
    start: { line: 0, character: 0 },
    end: { line: 0, character: 0 },
  };

  if (err.sourceLocation) {
    const { start, end } = err.sourceLocation;
    // Simple line counting - solc gives byte offsets
    const fileContent = readFileContent(err.sourceLocation.file, projectRoot);
    if (fileContent) {
      const startLoc = offsetToLineCol(fileContent, start);
      const endLoc = offsetToLineCol(fileContent, end);
      range = {
        start: startLoc,
        end: endLoc,
      };
    }
  }

  return {
    severity,
    range,
    message: err.message,
    source: 'solc',
    code: err.errorCode,
  };
}

function readFileContent(
  filePath: string,
  projectRoot: string
): string | null {
  try {
    const fullPath = path.isAbsolute(filePath)
      ? filePath
      : path.join(projectRoot, filePath);
    return fs.readFileSync(fullPath, 'utf-8');
  } catch {
    return null;
  }
}

function offsetToLineCol(
  content: string,
  byteOffset: number
): { line: number; character: number } {
  let line = 0;
  let character = 0;
  let currentByte = 0;

  for (let i = 0; i < content.length; i++) {
    const char = content[i];
    const charBytes = Buffer.byteLength(char, 'utf-8');

    if (currentByte + charBytes > byteOffset) {
      break;
    }

    currentByte += charBytes;

    if (char === '\n') {
      line++;
      character = 0;
    } else {
      character++;
    }
  }

  return { line, character };
}