import * as fs from 'fs';
import * as path from 'path';
import { pathToFileURL } from 'url';

export function findSolFiles(dir: string): Set<string> {
  const files = new Set<string>();
  walkDir(dir, files);
  return files;
}

function walkDir(dir: string, files: Set<string>): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'out') {
        continue;
      }
      walkDir(fullPath, files);
    } else if (entry.isFile() && entry.name.endsWith('.sol')) {
      files.add(pathToFileURL(fullPath).href);
    }
  }
}
