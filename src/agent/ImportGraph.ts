// File-level import graph — who imports whom, and which files matter most.
//
// Two consumers: RepoMap orders its digest by PageRank over this graph
// (Aider's validated design — a file imported by three core modules outranks
// one imported by ten leaf tests), and the file_deps tool exposes the edges
// to the agent directly (LocAgent, ACL 2025: graph navigation improved
// localization accuracy +10.5%, downstream issue resolution +12%).
//
// Precision matters less than recall here — the graph orders a digest and
// answers "who uses this file", it never gates correctness. So extraction is
// regex-based (no AST), resolution probes only the already-scanned file set
// (no fs access), and unresolvable specifiers are silently dropped. Go is
// deliberately not extracted: its imports are module-path-based (needs go.mod
// resolution) and same-package files rank together anyway.

export interface ImportGraph {
  /** Project-relative paths, forward slashes. */
  files: string[];
  /** file -> in-repo files it imports (deduped, no self-edges). */
  imports: Map<string, string[]>;
  /** Reverse edges: file -> files that import it. */
  importers: Map<string, string[]>;
  /** PageRank score per file — orders the repo-map digest. */
  rank: Map<string, number>;
}

// ── Specifier extraction ────────────────────────────────────────────────────

const JS_EXTS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);

// Returns raw specifiers. JS/TS: only relative ones ('./x', '../y') — package
// imports can't be repo files. Rust specifiers are prefixed ('mod:', 'crate:')
// so resolveImport can tell the two syntaxes apart.
export function extractImportSpecifiers(text: string, ext: string): string[] {
  const out: string[] = [];
  if (JS_EXTS.has(ext)) {
    const patterns = [
      // import ... from '...'; export ... from '...'
      /(?:^|\s)(?:import|export)\s[^;'"`]*?from\s*['"]([^'"]+)['"]/gm,
      // bare side-effect import: import './x'
      /(?:^|\s)import\s*['"]([^'"]+)['"]/gm,
      // require('...') and dynamic import('...')
      /\b(?:require|import)\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    ];
    for (const re of patterns) {
      let m: RegExpExecArray | null;
      while ((m = re.exec(text)) !== null) {
        const spec = m[1]!;
        if (spec.startsWith('.')) out.push(spec);
      }
    }
  } else if (ext === '.py') {
    let m: RegExpExecArray | null;
    const fromRe = /^\s*from\s+([.\w]+)\s+import\s/gm;
    while ((m = fromRe.exec(text)) !== null) out.push(m[1]!);
    const importRe = /^\s*import\s+([\w.]+)/gm;
    while ((m = importRe.exec(text)) !== null) out.push(m[1]!);
  } else if (ext === '.rs') {
    let m: RegExpExecArray | null;
    const modRe = /^\s*(?:pub\s+)?mod\s+(\w+)\s*;/gm;
    while ((m = modRe.exec(text)) !== null) out.push(`mod:${m[1]!}`);
    const useRe = /^\s*use\s+crate::([\w:]+)/gm;
    while ((m = useRe.exec(text)) !== null) out.push(`crate:${m[1]!.replace(/::/g, '/')}`);
  }
  return out;
}

// ── Resolution against the scanned file set ─────────────────────────────────

// Probe order for JS/TS: exact path → NodeNext .js→.ts swap (TS projects write
// `from './x.js'` for a file that exists as x.ts — autocode itself does) →
// extension append → directory index.
const JS_PROBE_EXTS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'];

export function resolveImport(
  spec: string,
  importerRel: string,
  fileSet: Set<string>,
): string | null {
  const ext = extOf(importerRel);
  if (JS_EXTS.has(ext)) return resolveJs(spec, importerRel, fileSet);
  if (ext === '.py') return resolvePython(spec, importerRel, fileSet);
  if (ext === '.rs') return resolveRust(spec, importerRel, fileSet);
  return null;
}

function resolveJs(spec: string, importerRel: string, fileSet: Set<string>): string | null {
  if (!spec.startsWith('.')) return null;
  const base = posixJoin(posixDirname(importerRel), spec);
  if (base === null) return null;
  const candidates: string[] = [base];
  const m = base.match(/^(.*)\.(js|jsx|mjs|cjs)$/);
  if (m) candidates.push(`${m[1]}.ts`, `${m[1]}.tsx`);
  for (const e of JS_PROBE_EXTS) candidates.push(base + e);
  for (const e of JS_PROBE_EXTS) candidates.push(`${base}/index${e}`);
  for (const c of candidates) if (fileSet.has(c)) return c;
  return null;
}

function resolvePython(spec: string, importerRel: string, fileSet: Set<string>): string | null {
  const dots = spec.match(/^(\.*)/)![1]!.length;
  const rest = spec.slice(dots).replace(/\./g, '/');
  const candidates: string[] = [];
  if (dots > 0) {
    // One dot = the importer's own package dir; each extra dot walks up.
    let dir = posixDirname(importerRel);
    for (let i = 1; i < dots; i++) dir = posixDirname(dir);
    const prefix = dir === '' ? '' : `${dir}/`;
    if (rest === '') candidates.push(`${prefix}__init__.py`);
    else candidates.push(`${prefix}${rest}.py`, `${prefix}${rest}/__init__.py`);
  } else {
    for (const prefix of ['', 'src/']) {
      candidates.push(`${prefix}${rest}.py`, `${prefix}${rest}/__init__.py`);
    }
  }
  for (const c of candidates) if (fileSet.has(c)) return c;
  return null;
}

function resolveRust(spec: string, importerRel: string, fileSet: Set<string>): string | null {
  const candidates: string[] = [];
  if (spec.startsWith('mod:')) {
    const name = spec.slice(4);
    const dir = posixDirname(importerRel);
    const prefix = dir === '' ? '' : `${dir}/`;
    candidates.push(`${prefix}${name}.rs`, `${prefix}${name}/mod.rs`);
  } else if (spec.startsWith('crate:')) {
    // `use crate::a::b` — b may be a module or an item inside module a, so
    // probe the full path first, then progressively strip trailing segments.
    let path = spec.slice(6);
    while (path.length > 0) {
      candidates.push(`src/${path}.rs`, `src/${path}/mod.rs`);
      const i = path.lastIndexOf('/');
      if (i === -1) break;
      path = path.slice(0, i);
    }
  }
  for (const c of candidates) if (fileSet.has(c)) return c;
  return null;
}

// ── Graph construction ──────────────────────────────────────────────────────

export function buildImportGraph(
  filesRel: string[],
  readText: (rel: string) => string | null,
): ImportGraph {
  const fileSet = new Set(filesRel);
  const imports = new Map<string, string[]>();
  const importers = new Map<string, string[]>();
  for (const f of filesRel) {
    imports.set(f, []);
    importers.set(f, []);
  }
  for (const f of filesRel) {
    const text = readText(f);
    if (text === null) continue;
    const targets = new Set<string>();
    for (const spec of extractImportSpecifiers(text, extOf(f))) {
      const t = resolveImport(spec, f, fileSet);
      if (t !== null && t !== f) targets.add(t);
    }
    const list = [...targets];
    imports.set(f, list);
    for (const t of list) importers.get(t)!.push(f);
  }
  return { files: filesRel, imports, importers, rank: pageRank(filesRel, imports) };
}

// Standard PageRank with dangling-mass redistribution. At RepoMap scale
// (≤400 nodes) 15 iterations is sub-millisecond; unlike raw in-degree it
// surfaces hub-of-hubs files (a types.ts imported by three CORE modules
// outranks a helper imported by ten leaf tests).
export function pageRank(
  nodes: string[],
  edges: Map<string, string[]>,
  iterations = 15,
  damping = 0.85,
): Map<string, number> {
  const n = nodes.length;
  const rank = new Map<string, number>();
  if (n === 0) return rank;
  for (const node of nodes) rank.set(node, 1 / n);

  for (let iter = 0; iter < iterations; iter++) {
    const next = new Map<string, number>();
    for (const node of nodes) next.set(node, (1 - damping) / n);
    let danglingMass = 0;
    for (const node of nodes) {
      const out = edges.get(node) ?? [];
      const r = rank.get(node)!;
      if (out.length === 0) {
        danglingMass += r;
      } else {
        const share = (damping * r) / out.length;
        for (const t of out) next.set(t, (next.get(t) ?? 0) + share);
      }
    }
    const danglingShare = (damping * danglingMass) / n;
    for (const node of nodes) {
      next.set(node, next.get(node)! + danglingShare);
      rank.set(node, next.get(node)!);
    }
  }
  return rank;
}

// ── Tiny posix path helpers (all graph paths are forward-slash relative) ────

function extOf(rel: string): string {
  const i = rel.lastIndexOf('.');
  const slash = rel.lastIndexOf('/');
  return i > slash ? rel.slice(i) : '';
}

function posixDirname(rel: string): string {
  const i = rel.lastIndexOf('/');
  return i === -1 ? '' : rel.slice(0, i);
}

// Join + normalize; returns null when '..' escapes the project root — such a
// specifier can never resolve to a scanned file.
function posixJoin(dir: string, spec: string): string | null {
  const parts = (dir === '' ? spec : `${dir}/${spec}`).split('/');
  const out: string[] = [];
  for (const part of parts) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (out.length === 0) return null;
      out.pop();
    } else {
      out.push(part);
    }
  }
  return out.join('/');
}
