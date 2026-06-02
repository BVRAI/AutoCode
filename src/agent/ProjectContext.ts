import { execSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { resolveGitBranch } from './SessionState.js';

export interface ProjectContext {
  root: string;
  types: string[];
  git: GitInfo | null;
}

export interface GitInfo {
  branch: string;
  dirty: number; // count of modified entries
}

// Marker files / extensions that indicate a project ecosystem.
// Reading order doesn't matter — we collect all matches.
const MARKERS: Array<{ when: (root: string) => boolean; label: string }> = [
  { when: (r) => existsSync(join(r, 'package.json')), label: 'node' },
  { when: (r) => hasAnyExt(r, ['.ts', '.tsx']), label: 'typescript' },
  { when: (r) => existsSync(join(r, 'pyproject.toml')) || existsSync(join(r, 'requirements.txt')) || existsSync(join(r, 'setup.py')), label: 'python' },
  { when: (r) => existsSync(join(r, 'Cargo.toml')), label: 'rust' },
  { when: (r) => existsSync(join(r, 'go.mod')), label: 'go' },
  { when: (r) => hasFileMatch(r, /\.csproj$/i) || hasFileMatch(r, /\.sln$/i), label: 'dotnet' },
  { when: (r) => existsSync(join(r, 'Gemfile')), label: 'ruby' },
  { when: (r) => existsSync(join(r, 'composer.json')), label: 'php' },
  { when: (r) => existsSync(join(r, 'pubspec.yaml')), label: 'dart' },
  { when: (r) => existsSync(join(r, 'mix.exs')), label: 'elixir' },
  { when: (r) => existsSync(join(r, 'pom.xml')) || existsSync(join(r, 'build.gradle')) || existsSync(join(r, 'build.gradle.kts')), label: 'jvm' },
];

export function detectProjectContext(root: string): ProjectContext {
  const types: string[] = [];
  for (const m of MARKERS) {
    try {
      if (m.when(root)) types.push(m.label);
    } catch {
      /* ignore */
    }
  }
  // Dedup while preserving order; "node" + "typescript" is common — keep both.
  const seen = new Set<string>();
  const uniq: string[] = [];
  for (const t of types) {
    if (!seen.has(t)) {
      uniq.push(t);
      seen.add(t);
    }
  }
  return { root, types: uniq, git: detectGit(root) };
}

function detectGit(root: string): GitInfo | null {
  if (!existsSync(join(root, '.git'))) return null;
  const resolved = resolveGitBranch(root);
  const branch = resolved
    ? resolved.isDetachedHead
      ? '(HEAD detached)'
      : resolved.branch
    : '(unknown)';
  let dirty = 0;
  try {
    const out = execSync('git status --porcelain', {
      cwd: root,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).toString();
    dirty = out.split('\n').filter((l) => l.trim().length > 0).length;
  } catch {
    dirty = 0;
  }
  return { branch, dirty };
}

export function formatContextLine(ctx: ProjectContext): string {
  const parts: string[] = [];
  if (ctx.types.length > 0) parts.push(ctx.types.join(', '));
  if (ctx.git) {
    const dirtyTag = ctx.git.dirty > 0 ? `${ctx.git.dirty} modified` : 'clean';
    parts.push(`git@${ctx.git.branch} (${dirtyTag})`);
  }
  return parts.join(' · ');
}

function hasAnyExt(dir: string, exts: string[]): boolean {
  return scanForMatch(dir, (name) => exts.some((e) => name.toLowerCase().endsWith(e)), 3);
}

function hasFileMatch(dir: string, re: RegExp): boolean {
  return scanForMatch(dir, (name) => re.test(name), 3);
}

// Lightweight recursive scan, bounded depth + entry count for cheapness.
function scanForMatch(dir: string, predicate: (name: string) => boolean, maxDepth: number): boolean {
  let count = 0;
  const stack: Array<{ path: string; depth: number }> = [{ path: dir, depth: 0 }];
  const NOISE = new Set(['node_modules', '.git', 'dist', 'build', '.next', '__pycache__', '.venv', 'venv', 'bin', 'obj']);
  while (stack.length > 0) {
    const { path, depth } = stack.pop()!;
    if (count > 500) return false;
    let entries: string[];
    try {
      entries = readdirSync(path);
    } catch {
      continue;
    }
    for (const name of entries) {
      count++;
      if (count > 500) return false;
      if (NOISE.has(name)) continue;
      if (predicate(name)) return true;
      if (depth < maxDepth) {
        const full = join(path, name);
        try {
          if (statSync(full).isDirectory()) {
            stack.push({ path: full, depth: depth + 1 });
          }
        } catch {
          /* ignore */
        }
      }
    }
  }
  return false;
}
