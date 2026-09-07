// The query-aware slice of the repo map (Aider's personalized PageRank): the
// files the current request most likely concerns, ranked by how its words —
// paths, identifiers, keywords — connect to the code graph. Rendered into
// the volatile suffix of the system prompt, so it changes every turn without
// touching the cached prefix. Empty when the request gives nothing to seed on.

import { tokenize, type CodeIndex, type EntityNode } from '../index/CodeIndex.js';

const DEFAULT_MAX_FILES = 8;
const DEFAULT_MAX_BYTES = 2_400;
const MAX_SYMBOLS_PER_FILE = 6;
/** A name shared by this many definitions says nothing about where to look. */
const COMMON_NAME_LIMIT = 20;
const STOP = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'into', 'when', 'where', 'what', 'which', 'then', 'than',
  'add', 'make', 'fix', 'change', 'update', 'remove', 'delete', 'create', 'new', 'can', 'you', 'please', 'should',
  'also', 'but', 'not', 'are', 'was', 'were', 'have', 'has', 'get', 'set', 'use', 'like', 'just', 'some', 'all',
  'file', 'files', 'code', 'function', 'class', 'method', 'page', 'button', 'view', 'tab', 'user', 'users', 'app',
  'src', 'lib', 'test', 'tests', 'index', 'main', 'default', 'export', 'import', 'const', 'let', 'var', 'return',
]);

export interface QuerySliceOptions {
  maxFiles?: number;
  maxBytes?: number;
}

export function buildQuerySlice(index: CodeIndex, query: string, opts: QuerySliceOptions = {}): string {
  const maxFiles = opts.maxFiles ?? DEFAULT_MAX_FILES;
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const seeds = new Map<string, number>();
  const matchedSymbols = new Map<string, Set<string>>();
  const bump = (path: string, weight: number): void => {
    seeds.set(path, (seeds.get(path) ?? 0) + weight);
  };
  const noteSymbol = (node: EntityNode): void => {
    const s = matchedSymbols.get(node.path) ?? new Set<string>();
    s.add(node.name);
    matchedSymbols.set(node.path, s);
  };

  // 1. Paths and file names written in the request.
  const words = query.split(/[\s,;()"'`]+/).map((w) => w.replace(/^[@.\/\\]+|[.:!?]+$/g, '').replace(/\\/g, '/')).filter(Boolean);
  for (const w of words) {
    const file = index.entity(w);
    if (file && (file.kind === 'file' || file.kind === 'textfile')) {
      bump(file.path, 3);
      continue;
    }
    if (w.includes('.') && !w.includes('/')) {
      for (const p of index.filePaths()) {
        if (p.endsWith(`/${w}`) || p === w) bump(p, 2);
      }
    }
  }

  // 2. Identifiers: exact symbol names (camelCase words survive as-is too).
  const seenTokens = new Set<string>();
  for (const w of words) {
    for (const tok of [w, ...tokenize(w)]) {
      const t = tok.toLowerCase();
      if (t.length < 3 || STOP.has(t) || seenTokens.has(t)) continue;
      seenTokens.add(t);
      const nodes = index.resolve(t).filter((n) => n.kind !== 'file' && n.kind !== 'textfile' && n.kind !== 'dir');
      if (nodes.length === 0 || nodes.length > COMMON_NAME_LIMIT) continue;
      for (const n of nodes) {
        bump(n.path, 1);
        noteSymbol(n);
      }
    }
  }

  // 3. Keyword hits over identifiers, paths and signatures.
  for (const h of index.search(query, { limit: 20 })) {
    if (h.why === 'exact name') continue; // already counted above
    bump(h.node.path, 0.5);
    if (h.node.kind !== 'file' && h.node.kind !== 'textfile') noteSymbol(h.node);
  }

  if (seeds.size === 0) return '';

  const ranks = index.fileRanks(seeds);
  const candidates = [...ranks.entries()]
    .filter(([, r]) => r > 0)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, maxFiles)
    .map(([path]) => path);
  if (candidates.length === 0) return '';

  const lines: string[] = [
    '# Likely relevant to this request',
    'From the code index, ranked by how the request\'s words connect to the graph. A hint, not an answer — verify with the tools before relying on it.',
  ];
  let bytes = lines.join('\n').length;
  for (const path of candidates) {
    const names: string[] = [...(matchedSymbols.get(path) ?? [])];
    for (const n of index.outline(path)) {
      if (names.length >= MAX_SYMBOLS_PER_FILE) break;
      if (!n.parent && !names.includes(n.name)) names.push(n.name);
    }
    const line = names.length > 0 ? `${path}  ·  ${names.slice(0, MAX_SYMBOLS_PER_FILE).join(', ')}` : path;
    if (bytes + line.length + 1 > maxBytes) break;
    lines.push(line);
    bytes += line.length + 1;
  }
  return lines.length > 2 ? lines.join('\n') : '';
}
