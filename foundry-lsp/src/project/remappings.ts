import { execFileSync } from 'child_process';

export function loadRemappings(projectRoot: string): Map<string, string> {
  const remappings = new Map<string, string>();

  try {
    const output = execFileSync('forge', ['remappings'], {
      cwd: projectRoot,
      encoding: 'utf-8',
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    for (const line of output.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      const eqIdx = trimmed.indexOf('=');
      if (eqIdx === -1) continue;

      const prefix = trimmed.slice(0, eqIdx).trim();
      const target = trimmed.slice(eqIdx + 1).trim();

      if (prefix && target) {
        remappings.set(prefix, target);
      }
    }
  } catch {
    // forge not available or no remappings — return empty
  }

  return remappings;
}
