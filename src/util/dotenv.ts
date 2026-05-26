import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// Minimal .env loader. No quoting magic, no interpolation. Reads KEY=VALUE
// lines and sets into process.env only if not already set (so explicit env
// vars always win).
//
// Discovery order (first hit wins per key):
//   1. existing process.env (untouched)
//   2. <cwd>/.env             — per-project override
//   3. ~/.autocode/.env       — per-user fallback so `acv1` from any
//                                directory finds the user's API keys
//
// `loaded` counts unique keys set; `paths` lists which files were read.
export interface DotEnvResult {
  loaded: number;
  paths: string[];
  // Kept for backwards-compat with callers that read .path (the cwd file).
  path: string | null;
}

export function loadDotEnv(cwd: string = process.cwd()): DotEnvResult {
  const candidates = [join(cwd, '.env'), join(homedir(), '.autocode', '.env')];
  let loaded = 0;
  const paths: string[] = [];
  for (const path of candidates) {
    if (!existsSync(path)) continue;
    let raw: string;
    try {
      raw = readFileSync(path, 'utf8');
    } catch {
      continue;
    }
    paths.push(path);
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
  }
  return { loaded, paths, path: paths[0] ?? null };
}
