import { readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, relative, sep } from 'node:path';
import { NOISE_DIRS } from '../tools/listDirectory.js';
import { buildImportGraph, type ImportGraph } from './ImportGraph.js';
import { peekIndex } from '../index/IndexManager.js';
import type { CodeIndex } from '../index/CodeIndex.js';
import { contextWindowFor } from '../util/contextWindow.js';

const MAX_DIGEST_BYTES = 6000;
const MAX_FILES = 400;
const MAX_SYMBOLS_PER_FILE = 10;
const MAX_READ_BYTES = 64_000;
// Share of the digest budget spent on ranked symbol lines; the remainder
// lists leftover files as bare paths so the tree stays visible even when
// symbol detail doesn't fit (Aider's detail + coverage mix).
const PHASE1_BUDGET_FRACTION = 0.75;

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
  graph: ImportGraph;
  // Set when the digest came from the tree-sitter index (Phase 3): the
  // index build it reflects and the byte budget it was packed into.
  indexBuiltAt?: number;
  budget?: number;
}

const mapCache = new Map<string, RepoMapInfo>();
// Roots whose files changed since their map was built. The rebuild is
// deferred to a turn boundary — see refreshRepoMapIfStale.
const dirtyRoots = new Set<string>();

// A compact digest of the project — file tree + top-level symbols — injected
// into the system prompt so the agent can navigate without blind re-reads.
// Cached per project root; refreshed at turn boundaries after mutations.
export function getRepoMap(projectRoot: string): string {
  return repoMapInfo(projectRoot).digest;
}

// Mark a root's map stale (a file was created/edited/deleted). Cheap — the
// actual rebuild happens at the next turn boundary.
export function invalidateRepoMap(projectRoot: string): void {
  if (mapCache.has(projectRoot)) dirtyRoots.add(projectRoot);
}

// Rebuild a stale map. Called at TURN boundaries (AgentLoop.submit), not
// per-edit: the digest is part of the cached system-prompt prefix, so
// rebuilding between iterations would bust the provider prompt cache
// repeatedly within a single turn. Returns true when a rebuild happened.
export function refreshRepoMapIfStale(projectRoot: string): boolean {
  if (!dirtyRoots.has(projectRoot)) return false;
  dirtyRoots.delete(projectRoot);
  mapCache.set(projectRoot, buildRepoMapInfo(projectRoot));
  return true;
}

// Unconditional rebuild — the /refresh command.
export function forceRefreshRepoMap(projectRoot: string): void {
  dirtyRoots.delete(projectRoot);
  mapCache.set(projectRoot, buildRepoMapInfo(projectRoot));
}

// Phase 3: once the tree-sitter index is ready, the digest comes from it —
// every file with a grammar plus docs/config, symbols with nesting, PageRank
// over imports AND calls, and a budget scaled to the model's context window
// instead of the fixed 6 KB. Called at TURN boundaries only (AgentLoop.submit,
// after the index's stat pass) so the digest — part of the cached
// system-prompt prefix — never changes mid-turn. Returns true on a rebuild.
export function adoptIndexIfReady(projectRoot: string, model?: { provider: string; model: string }): boolean {
  const index = peekIndex(projectRoot);
  if (!index || index.builtAt === 0) return false;
  const budget = model ? repoMapBudgetBytes(model.provider, model.model) : MAX_DIGEST_BYTES;
  const cached = mapCache.get(projectRoot);
  if (cached && cached.indexBuiltAt === index.builtAt && cached.budget === budget) return false;
  const base = cached ?? buildRepoMapInfo(projectRoot);
  mapCache.set(projectRoot, { ...base, digest: indexDigest(index, budget), indexBuiltAt: index.builtAt, budget });
  return true;
}

// Aider's rule of thumb scaled: ~2% of the window, between 1.5k and 8k
// tokens (≈4 bytes per token of path-heavy text). A 200k model gets ~16 KB.
export function repoMapBudgetBytes(provider: string, model: string): number {
  const window = contextWindowFor(provider, model);
  const tokens = Math.max(1500, Math.min(8000, Math.floor(window * 0.02)));
  return tokens * 4;
}

// True when the current digest is index-backed (tests, /refresh output).
export function repoMapIsIndexBacked(projectRoot: string): boolean {
  return mapCache.get(projectRoot)?.indexBuiltAt !== undefined;
}

function indexDigest(index: CodeIndex, budget: number): string {
  const files = index.filePaths();
  const ranks = index.fileRanks();
  const inDeg = (rel: string): number => index.edgesTo(rel, ['imports']).length;
  const score = (rel: string): number => (ranks.get(rel) ?? 0) * (1 + inDeg(rel));
  const ordered = [...files].sort((a, b) => {
    if (score(b) !== score(a)) return score(b) - score(a);
    if (inDeg(b) !== inDeg(a)) return inDeg(b) - inDeg(a);
    return a < b ? -1 : a > b ? 1 : 0;
  });
  const symbolsOf = (rel: string): string[] => {
    const out: string[] = [];
    for (const n of index.outline(rel)) {
      if (n.parent) continue;
      if (!out.includes(n.name)) out.push(n.name);
      if (out.length >= MAX_SYMBOLS_PER_FILE) break;
    }
    return out;
  };
  return packDigest(ordered, symbolsOf, inDeg, budget);
}

// Number of source files scanned for the repo map (capped at MAX_FILES). A
// stable per-session "how big is this repo" signal used for prompt gating.
export function repoFileCount(projectRoot: string): number {
  return repoMapInfo(projectRoot).fileCount;
}

// The file-level import graph built during the repo-map scan — consumed by
// the file_deps tool. Same cache and lifecycle as the digest.
export function getImportGraph(projectRoot: string): ImportGraph {
  return repoMapInfo(projectRoot).graph;
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

  // Read each file ONCE — symbol extraction and the import graph share it.
  const rels: string[] = [];
  const textByRel = new Map<string, string>();
  const symbolsByRel = new Map<string, string[]>();
  for (const abs of files) {
    const rel = relative(projectRoot, abs).split(sep).join('/');
    rels.push(rel);
    let text = '';
    try {
      text = readFileSync(abs, 'utf8');
    } catch {
      /* unreadable — empty text, no symbols, no edges */
    }
    if (text.length > MAX_READ_BYTES) text = text.slice(0, MAX_READ_BYTES);
    textByRel.set(rel, text);
    symbolsByRel.set(rel, extractSymbolsFromText(text, extname(abs)));
  }
  const graph = buildImportGraph(rels, (rel) => textByRel.get(rel) ?? null);

  // Importance ordering — the fix for the old alphabetical digest, which on
  // a big repo showed an arbitrary a-to-d slice instead of the files that
  // matter. Score = PageRank × (1 + in-degree): PageRank alone over-rewards
  // the single import of a high-rank hub (funnel effect — on a small graph a
  // leaf utility fed only by core.ts can outrank core.ts itself), while raw
  // in-degree alone misses hub-of-hubs files. The product wants both breadth
  // (many importers) and depth (important importers).
  const inDeg = (rel: string): number => graph.importers.get(rel)?.length ?? 0;
  const score = (rel: string): number => (graph.rank.get(rel) ?? 0) * (1 + inDeg(rel));
  const ordered = [...rels].sort((a, b) => {
    if (score(b) !== score(a)) return score(b) - score(a);
    if (inDeg(b) !== inDeg(a)) return inDeg(b) - inDeg(a);
    return a < b ? -1 : a > b ? 1 : 0;
  });

  const digest = packDigest(ordered, (rel) => symbolsByRel.get(rel) ?? [], inDeg, MAX_DIGEST_BYTES);
  return { digest, fileCount, graph };
}

// Pack ranked files into a digest: symbol lines first (phase 1, most of the
// budget), then the leftover files as comma-packed bare paths so the tree
// stays visible when detail doesn't fit (Aider's detail + coverage mix).
// Shared by the regex map and the index-backed map so the model sees one
// format either way.
function packDigest(
  ordered: readonly string[],
  symbolsOf: (rel: string) => string[],
  inDeg: (rel: string) => number,
  maxBytes: number,
): string {
  const lines: string[] = [];
  let bytes = 0;
  const phase1Budget = Math.floor(maxBytes * PHASE1_BUDGET_FRACTION);
  let idx = 0;
  for (; idx < ordered.length; idx++) {
    const rel = ordered[idx]!;
    const symbols = symbolsOf(rel);
    const n = inDeg(rel);
    const line =
      (symbols.length > 0 ? `${rel}  ·  ${symbols.join(', ')}` : rel) +
      (n >= 2 ? `  (imported by ${n})` : '');
    if (bytes + line.length + 1 > phase1Budget) break;
    lines.push(line);
    bytes += line.length + 1;
  }

  // Phase 2 — leftover files as comma-packed bare paths (alphabetical: the
  // tail reads as a tree listing, not a ranking).
  let truncated = false;
  if (idx < ordered.length) {
    const rest = ordered.slice(idx).sort();
    const header = '— other files —';
    lines.push(header);
    bytes += header.length + 1;
    let current = '';
    for (const rel of rest) {
      const candidate = current === '' ? rel : `${current}, ${rel}`;
      if (candidate.length > 100 && current !== '') {
        if (bytes + current.length + 1 > maxBytes) {
          truncated = true;
          current = '';
          break;
        }
        lines.push(current);
        bytes += current.length + 1;
        current = rel;
      } else {
        current = candidate;
      }
    }
    if (current !== '') {
      if (bytes + current.length + 1 > maxBytes) truncated = true;
      else lines.push(current);
    }
    if (rest.length > 0 && idx < ordered.length && lines[lines.length - 1] === header && truncated === false) {
      // Nothing from phase 2 fit at all — drop the dangling header.
      lines.pop();
      truncated = true;
    }
  }

  return lines.length === 0 ? '' : lines.join('\n') + (truncated ? '\n… (repo map truncated)' : '');
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
// identifier. The pattern always captures the bound name in group 1 (or
// group 2 for languages with a second branch, e.g. TS `export const X`,
// Java/C# method signatures). Anchored to start-of-line (some languages
// permit leading whitespace for class-member declarations). Shared between
// RepoMap (which extracts ALL declared symbols in a file) and the
// find_symbol tool (which searches for a specific name). Every language
// advertised in find_symbol's `language` enum MUST have a pattern here —
// a silent null means the tool claims support it doesn't have.
export function declarationPatternForExt(ext: string): RegExp | null {
  if (['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'].includes(ext)) {
    return /^(?:export\s+(?:default\s+)?)?(?:async\s+)?(?:function|class|interface|type|enum)\s+([\w$]+)|^export\s+const\s+([\w$]+)/gm;
  }
  if (ext === '.py') return /^\s*(?:def|class)\s+([A-Za-z_]\w*)/gm;
  if (ext === '.go') return /^(?:func|type)\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/gm;
  if (ext === '.rs') return /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:fn|struct|enum|trait)\s+([A-Za-z_]\w*)/gm;
  if (ext === '.java') {
    // Branch 1: type declarations (class/interface/enum/record).
    // Branch 2: modifier-prefixed method signatures (requires ≥1 modifier so
    // control-flow lines like `if (…)` can't match).
    return /^\s*(?:(?:public|private|protected|static|final|abstract|sealed|synchronized|strictfp)\s+)*(?:class|interface|enum|record)\s+([A-Za-z_]\w*)|^\s*(?:(?:public|private|protected|static|final|abstract|synchronized)\s+)+[\w<>[\],\s?]+?\s+([A-Za-z_]\w*)\s*\(/gm;
  }
  if (ext === '.rb') return /^\s*(?:def\s+(?:self\.)?|class\s+|module\s+)([A-Za-z_]\w*[?!=]?)/gm;
  if (ext === '.php') {
    return /^\s*(?:(?:public|private|protected|static|abstract|final)\s+)*(?:function\s+&?|class\s+|interface\s+|trait\s+|enum\s+)([A-Za-z_]\w*)/gm;
  }
  if (ext === '.cs') {
    return /^\s*(?:(?:public|private|protected|internal|static|sealed|abstract|partial|readonly|virtual|override|async)\s+)*(?:class|interface|struct|enum|record)\s+([A-Za-z_]\w*)|^\s*(?:(?:public|private|protected|internal|static|virtual|override|async|sealed|abstract)\s+)+[\w<>[\],\s?]+?\s+([A-Za-z_]\w*)\s*\(/gm;
  }
  return null;
}

// The set of source extensions both RepoMap and find_symbol scan.
export const SCANNED_SOURCE_EXT = SOURCE_EXT;

// Cheap, per-language extraction of top-level declaration names. Anchored to
// the start of a line so indented (local / member) declarations are skipped.
// Takes text (not a path) so the repo-map scan reads each file exactly once.
function extractSymbolsFromText(text: string, ext: string): string[] {
  const re = declarationPatternForExt(ext);
  if (!re) return [];

  const names: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null && names.length < MAX_SYMBOLS_PER_FILE) {
    const name = m[1] ?? m[2];
    if (name && !names.includes(name)) names.push(name);
  }
  return names;
}
