import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// Minimal .env loader. No quoting magic, no interpolation. Read KEY=VALUE
// lines from `<cwd>/.env` if present, and set into process.env only if not
// already set (so explicit env vars always win).
export function loadDotEnv(cwd: string = process.cwd()): { loaded: number; path: string | null } {
  const path = join(cwd, '.env');
  if (!existsSync(path)) return { loaded: 0, path: null };
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return { loaded: 0, path };
  }
  let loaded = 0;
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    // Strip a single layer of surrounding quotes if present.
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) {
      process.env[key] = value;
      loaded += 1;
    }
  }
  return { loaded, path };
}
