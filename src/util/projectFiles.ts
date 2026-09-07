// Project file list for the composer's `@` picker: `git ls-files` (tracked +
// untracked, respecting .gitignore) with a bounded directory walk as the
// fallback for folders that are not repositories. Cached briefly per root.

import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

const CACHE_TTL_MS = 30_000;
const MAX_FILES = 20_000;
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'out', '.next', 'bin', 'obj', '.cache', 'coverage']);

const cache = new Map<string, { at: number; files: string[] }>();

export function listProjectFiles(root: string): string[] {
  const hit = cache.get(root);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.files;
  let files: string[];
  try {
    const out = execFileSync('git', ['ls-files', '-co', '--exclude-standard', '-z'], {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    });
    files = out.split('\0').filter((f) => f.length > 0);
    if (files.length === 0) files = walk(root);
  } catch {
    files = walk(root);
  }
  files = files.slice(0, MAX_FILES).map((f) => f.replace(/\\/g, '/'));
  cache.set(root, { at: Date.now(), files });
  return files;
}

export function invalidateProjectFiles(root?: string): void {
  if (root) cache.delete(root);
  else cache.clear();
}

function walk(root: string): string[] {
  const out: string[] = [];
  const stack = [root];
  while (stack.length > 0 && out.length < MAX_FILES) {
    const dir = stack.pop()!;
    let entries: import('node:fs').Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) stack.push(join(dir, e.name));
      } else if (e.isFile()) {
        out.push(relative(root, join(dir, e.name)));
      }
    }
  }
  return out.sort();
}

/**
 * Rank paths for a picker query: every query character must appear in order
 * (case-insensitive); matches at the start of a path segment or the basename
 * score higher, consecutive matches higher still, shorter paths win ties.
 * An empty query lists the shallowest paths first.
 */
export function fuzzyRankPaths(paths: readonly string[], query: string, limit = 10): string[] {
  const q = query.trim().toLowerCase();
  if (q.length === 0) {
    return [...paths]
      .sort((a, b) => depth(a) - depth(b) || a.localeCompare(b))
      .slice(0, limit);
  }
  const scored: Array<{ path: string; score: number }> = [];
  for (const p of paths) {
    const s = scorePath(p, q);
    if (s !== null) scored.push({ path: p, score: s });
  }
  scored.sort((a, b) => b.score - a.score || a.path.length - b.path.length || a.path.localeCompare(b.path));
  return scored.slice(0, limit).map((s) => s.path);
}

function depth(p: string): number {
  return p.split('/').length;
}

function scorePath(path: string, q: string): number | null {
  const lower = path.toLowerCase();
  const base = lower.lastIndexOf('/') + 1;
  // Try the basename first so "cli" lands on src/cli.ts via its basename,
  // not via the c in "src"; fall back to a match anywhere in the path.
  const inBase = matchFrom(lower, q, base);
  const anywhere = matchFrom(lower, q, 0);
  const best = Math.max(inBase ?? -Infinity, anywhere ?? -Infinity);
  if (best === -Infinity) return null;
  let score = best;
  // Whole-query substring in the basename beats scattered matches.
  if (lower.slice(base).includes(q)) score += 5;
  return score - lower.length * 0.01;
}

function matchFrom(lower: string, q: string, from: number): number | null {
  const base = lower.lastIndexOf('/') + 1;
  let score = 0;
  let qi = 0;
  let prevMatched = false;
  for (let i = from; i < lower.length && qi < q.length; i++) {
    if (lower[i] !== q[qi]) {
      prevMatched = false;
      continue;
    }
    const segmentStart = i === 0 || '/-_.'.includes(lower[i - 1]!);
    score += 1;
    if (i === base) score += 4; // basename starts with the query character
    else if (segmentStart) score += 2;
    if (prevMatched) score += 1;
    prevMatched = true;
    qi++;
  }
  return qi < q.length ? null : score;
}
