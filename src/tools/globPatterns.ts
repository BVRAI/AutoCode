// Pattern hygiene shared by the glob and grep tools.
//
// Two things models write on real projects that tinyglobby reads differently:
//   - `**/*.{ts,tsx}`: the comma inside braces is a brace alternative, not a
//     second pattern (the glob tool accepts comma-separated patterns).
//   - `src/app/[locale]/**`: Next.js dynamic-route directories are literal
//     names, but `[locale]` is a character class to a glob engine.

import { listProjectFiles } from '../util/projectFiles.js';

/** Split a comma-separated pattern list, leaving commas inside `{…}` alone. */
export function splitPatterns(pattern: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of pattern) {
    if (ch === '{') depth += 1;
    else if (ch === '}') depth = Math.max(0, depth - 1);
    if (ch === ',' && depth === 0) {
      out.push(current.trim());
      current = '';
      continue;
    }
    current += ch;
  }
  out.push(current.trim());
  return out.filter((p) => p.length > 0);
}

/**
 * Escape `[name]` segments that name a real directory of the project so they
 * match literally. Only segments that exist on disk are touched; a genuine
 * character class (`[abc]`) with no such directory is left as written.
 */
export function escapeLiteralBrackets(pattern: string, root: string): string {
  if (!/\[[^\]/]+\]/.test(pattern)) return pattern;
  let dirs: Set<string> | null = null;
  const knownDir = (name: string): boolean => {
    if (!dirs) {
      dirs = new Set<string>();
      for (const rel of listProjectFiles(root)) {
        const parts = rel.split('/');
        for (let i = 0; i < parts.length - 1; i++) dirs.add(parts[i]!);
      }
    }
    return dirs.has(name);
  };
  return pattern
    .split('/')
    .map((seg) => {
      const m = /^\[([^\]/]+)\]$/.exec(seg);
      if (!m || seg.startsWith('\\')) return seg;
      return knownDir(seg) ? `\\[${m[1]}\\]` : seg;
    })
    .join('/');
}

/** Both fixes, for one pattern string as the model wrote it. */
export function normalizePatterns(pattern: string, root: string): string[] {
  return splitPatterns(pattern).map((p) => escapeLiteralBrackets(p, root));
}
