import * as fs from 'fs';
import * as path from 'path';
import * as toml from '@iarna/toml';

export interface FoundryConfig {
  src: string;
  out: string;
  libs: string[];
  solcVersion: string | null;
}

const DEFAULT_CONFIG: FoundryConfig = {
  src: 'src',
  out: 'out',
  libs: ['lib'],
  solcVersion: null,
};

export function parseFoundryToml(projectRoot: string): FoundryConfig {
  const tomlPath = path.join(projectRoot, 'foundry.toml');

  if (!fs.existsSync(tomlPath)) {
    return { ...DEFAULT_CONFIG };
  }

  try {
    const content = fs.readFileSync(tomlPath, 'utf-8');
    const parsed = toml.parse(content) as Record<string, any>;
    const config = { ...DEFAULT_CONFIG };

    // Resolve the active profile (default to "default")
    const profileName = parsed.profile ?? 'default';
    const profile = parsed.profile?.[profileName] ?? parsed;

    // Top-level keys take precedence, then profile
    if (typeof parsed.src === 'string') config.src = parsed.src;
    else if (typeof profile.src === 'string') config.src = profile.src;

    if (typeof parsed.out === 'string') config.out = parsed.out;
    else if (typeof profile.out === 'string') config.out = profile.out;

    // libs can be top-level or in profile
    const libs = parsed.libs ?? profile.libs;
    if (Array.isArray(libs)) {
      config.libs = libs.map(String).filter(Boolean);
    }

    // solc_version or solc
    const solcVersion = parsed.solc_version ?? parsed.solc ?? profile.solc_version ?? profile.solc;
    if (typeof solcVersion === 'string') {
      config.solcVersion = solcVersion;
    }

    return config;
  } catch {
    // If TOML parsing fails, fall back to defaults
    return { ...DEFAULT_CONFIG };
  }
}
