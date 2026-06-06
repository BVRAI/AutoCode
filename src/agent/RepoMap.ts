import { readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, relative, sep } from 'node:path';
import { NOISE_DIRS } from '../tools/listDirectory.js';

const MAX_DIGEST_BYTES = 6000;
const MAX_FILES = 400;
const MAX_SYMBOLS_PER_FILE = 10;
const MAX_READ_BYTES = 64_000;

const SOURCE_EXT = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.py', '.go', '.rs', '.java', '.rb', '.php', '.cs',
  '.css', '.scss', '.html', '.vue', '.svelte',
]);

// Repo size at/above which the system prompt switches on the "navigating a
// large codebase" localization protocol. Polyglot-style single-exercise repos
// sit far below this; real projects sit far above. Stable per session, so
// gating on it is cache-safe (same pattern as the git-skill gate).
export const LARGE_REPO_FILE_THRESHOLD = 25;

interface RepoMapInfo {
  digest: string;
  fileCount: number;
}

const mapCache = new Map<string, RepoMapInfo>();

// A compact digest of the project — file tree + top-level symbols — injected
// into the system prompt so the agent can navigate without blind re-reads.
// Cached per project root for the life of the process.
export function getRepoMap(projectRoot: string): string {
  return repoMapInfo(projectRoot).digest;
}

// Number of source files scanned for the repo map (capped at MAX_FILES). A
// stable per-session "how big is this repo" signal used for prompt gating.
export function repoFileCount(projectRoot: string): number {
  return repoMapInfo(projectRoot).fileCount;
}

function repoMapInfo(projectRoot: string): RepoMapInfo {
  const cached = mapCache.get(projectRoot);
  if (cached !== undefined) return cached;
  const info = buildRepoMapInfo(projectRoot);
  mapCache.set(projectRoot, info);
  return info;
}

export function buildRepoMap(projectRoot: string): string {
  return buildRepoMapInfo(projectRoot).digest;
}

function buildRepoMapInfo(projectRoot: string): RepoMapInfo {
  const files: string[] = [];
  collect(projectRoot, files, 0);
  files.sort();
  const fileCount = files.length;

  const lines: string[] = [];
  let bytes = 0;
  let truncated = false;
  for (const abs of files) {
    const rel = relative(projectRoot, abs).split(sep).join('/');
    const symbols = extractSymbols(abs);
    const line = symbols.length > 0 ? `${rel}  ·  ${symbols.join(', ')}` : rel;
    if (bytes + line.length + 1 > MAX_DIGEST_BYTES) {
      truncated = true;
      break;
    }
    lines.push(line);
    bytes += line.length + 1;
  }
  const digest = lines.length === 0 ? '' : lines.join('\n') + (truncated ? '\n… (repo map truncated)' : '');
  return { digest, fileCount };
}

function collect(dir: string, out: string[], depth: number): void {
  if (out.length >= MAX_FILES || depth > 12) return;
  let names: string[];
  try {
    names = readdirSync(dir).sort();
  } catch {
    return;
  }
  for (const name of names) {
    if (out.length >= MAX_FILES) return;
    if (NOISE_DIRS.has(name)) continue;
    const full = join(dir, name);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      collect(full, out, depth + 1);
    } else if (SOURCE_EXT.has(extname(name))) {
      out.push(full);
    }
  }
}

// Per-language regex for matching a top-level declaration of a *named*
// identifier. The pattern always captures the bound name in group 1 (or 2
// for the TS `export const X` branch). Anchored to start-of-line so indented
// / nested declarations are skipped. Shared between RepoMap (which extracts
// ALL declared symbols in a file) and the find_symbol tool (which searches
// for a specific name).
export function declarationPatternForExt(ext: string): RegExp | null {
  if (['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'].includes(ext)) {
    return /^(?:export\s+(?:default\s+)?)?(?:async\s+)?(?:function|class|interface|type|enum)\s+([\w$]+)|^export\s+const\s+([\w$]+)/gm;
  }
  if (ext === '.py') return /^\s*(?:def|class)\s+([A-Za-z_]\w*)/gm;
  if (ext === '.go') return /^(?:func|type)\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/gm;
  if (ext === '.rs') return /^\s*(?:pub\s+)?(?:fn|struct|enum|trait)\s+([A-Za-z_]\w*)/gm;
  return null;
}

// The set of source extensions both RepoMap and find_symbol scan.
export const SCANNED_SOURCE_EXT = SOURCE_EXT;

// Cheap, per-language extraction of top-level declaration names. Anchored to
// the start of a line so indented (local / member) declarations are skipped.
function extractSymbols(absPath: string): string[] {
  let text: string;
  try {
    text = readFileSync(absPath, 'utf8');
  } catch {
    return [];
  }
  if (text.length > MAX_READ_BYTES) text = text.slice(0, MAX_READ_BYTES);

  const re = declarationPatternForExt(extname(absPath));
  if (!re) return [];

  const names: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null && names.length < MAX_SYMBOLS_PER_FILE) {
    const name = m[1] ?? m[2];
    if (name && !names.includes(name)) names.push(name);
  }
  return names;
}
