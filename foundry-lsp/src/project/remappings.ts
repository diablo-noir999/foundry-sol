import { execFile } from 'child_process';
import { readFile, access } from 'fs/promises';
import { promisify } from 'util';
import { join } from 'path';

const execFileAsync = promisify(execFile);

/**
 * Parse remappings content. Each line is `prefix=target`.
 */
function parseRemappingsFile(content: string): Map<string, string> {
  const remappings = new Map<string, string>();

  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

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

/**
 * Load remappings with priority: foundry.toml > forge remappings > remappings.txt
 */
export async function loadRemappings(
  projectRoot: string,
  foundryTomlRemappings?: Map<string, string>
): Promise<Map<string, string>> {
  const merged = new Map<string, string>();

  // 1. Start with foundry.toml remappings (highest priority)
  if (foundryTomlRemappings) {
    for (const [prefix, target] of foundryTomlRemappings) {
      merged.set(prefix, target);
    }
  }

  // 2. Try forge remappings (overlaps with foundry.toml are skipped)
  try {
    const { stdout } = await execFileAsync('forge', ['remappings'], {
      cwd: projectRoot,
      timeout: 5000,
      encoding: 'utf-8',
    });

    const forgeRemappings = parseRemappingsFile(stdout);
    for (const [prefix, target] of forgeRemappings) {
      if (!merged.has(prefix)) {
        merged.set(prefix, target);
      }
    }
    return merged;
  } catch {
    // forge not available — fall back to remappings.txt
  }

  // 3. Fallback: try reading remappings.txt
  const remappingsPath = join(projectRoot, 'remappings.txt');
  try {
    await access(remappingsPath);
    const content = await readFile(remappingsPath, 'utf-8');
    const fileRemappings = parseRemappingsFile(content);
    for (const [prefix, target] of fileRemappings) {
      if (!merged.has(prefix)) {
        merged.set(prefix, target);
      }
    }
  } catch {
    // No remappings.txt either
  }

  return merged;
}
