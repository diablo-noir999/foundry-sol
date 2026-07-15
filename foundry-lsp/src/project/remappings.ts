import { execFile } from 'child_process';
import { readFile, access } from 'fs/promises';
import { promisify } from 'util';
import { join } from 'path';

const execFileAsync = promisify(execFile);

/**
 * Parse remappings.txt content. Each line is `prefix=target`.
 */
function parseRemappingsFile(content: string): Map<string, string> {
  const remappings = new Map<string, string>();

  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue; // skip empty lines and comments

    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;

    const prefix = trimmed.slice(0, eqIdx).trim();
    const target = trimmed.slice(eqIdx + 1).trim();

    if (prefix && target) {
      remappings.set(prefix, target);
    }
  }

  return remappings;
}

export async function loadRemappings(projectRoot: string): Promise<Map<string, string>> {
  // Try forge remappings first
  try {
    const { stdout } = await execFileAsync('forge', ['remappings'], {
      cwd: projectRoot,
      timeout: 5000,
      encoding: 'utf-8',
    });

    return parseRemappingsFile(stdout);
  } catch {
    // forge not available — fall back to remappings.txt
  }

  // Fallback: try reading remappings.txt
  const remappingsPath = join(projectRoot, 'remappings.txt');
  try {
    await access(remappingsPath);
    const content = await readFile(remappingsPath, 'utf-8');
    return parseRemappingsFile(content);
  } catch {
    // No remappings.txt either — return empty
  }

  return new Map<string, string>();
}
