// CodeIndex — the project as a graph of entities the agent can search and
// walk, built from tree-sitter symbol extraction.
//
//   nodes: dir → file → class/function/method/… (+ text files for docs/config)
//   edges: contains, imports (file → file), invokes (def → def), inherits
//
// On top of the graph: a name table (exact/prefix lookup), a small BM25 index
// over identifier, path and signature tokens, and PageRank over the file graph
// (optionally personalized toward the files a request mentions).
//
// Per-file extraction results are cached under the data dir keyed by the
// project root, so a second session starts from the cache and re-parses only
// the files whose mtime or size changed. Building is deterministic — no model
// calls — and safe to run in the background while the first prompt streams.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { dataDir } from '../util/paths.js';
import { invalidateProjectFiles, listProjectFiles } from '../util/projectFiles.js';
import { resolveImport } from '../agent/ImportGraph.js';
import { NOISE_DIRS } from '../tools/listDirectory.js';
import { languageForPath, isTextPath, type LanguageId } from './languages.js';
import { traced, tracedSync } from '../util/trace.js';
import { extractSymbols, type DefKind, type FileSymbols, type SymbolDef } from './extract.js';
import { hasGrammar } from './parser.js';

export type NodeKind = 'dir' | 'file' | 'textfile' | DefKind;

export interface EntityNode {
  id: string;
  kind: NodeKind;
  name: string;
  /** Project-relative path with forward slashes. */
  path: string;
  /** Dotted name inside its file ("App.render"); the path for files and dirs. */
  fqn: string;
  startLine?: number;
  endLine?: number;
  parent?: string;
  signature?: string;
  lang?: LanguageId;
}

export type EdgeKind = 'contains' | 'imports' | 'invokes' | 'inherits';

export interface Edge {
  from: string;
  to: string;
  kind: EdgeKind;
  /** Resolved by bare name across files (no import path): a guess, kept out of ranking. */
  weak?: boolean;
}

export interface SearchHit {
  node: EntityNode;
  score: number;
  why: string;
}

export interface RefreshStats {
  added: number;
  changed: number;
  removed: number;
  total: number;
  ms: number;
}

interface FileRecord {
  mtimeMs: number;
  size: number;
  lang?: LanguageId;
  text?: boolean;
  symbols?: FileSymbols;
  /** First tokens of a text file (headings, keys) for search. */
  head?: string;
  /** Vendored / minified / generated: a file node only, no symbols. */
  generated?: boolean;
}

interface CacheFile {
  version: number;
  root: string;
  files: Record<string, FileRecord>;
}

const INDEX_VERSION = 2;
const MAX_FILE_BYTES = 512 * 1024;
const MAX_FILES = 20_000;
const TEXT_HEAD_BYTES = 2_000;
const MIN_REFRESH_INTERVAL_MS = 1_500;
/** Names this common are never resolved across files (too noisy). */
const MAX_GLOBAL_CANDIDATES = 12;
/** Vendored, minified or generated code: indexed as a file, never for symbols. */
const GENERATED_PATH = /(^|\/)(vendor|vendors|third_party|thirdparty|generated|__generated__)\/|\.min\.(js|css|mjs)$|[-.]bundle\.(js|mjs)$|\.g\.cs$|\.designer\.cs$|\.generated\.[jt]sx?$|\.d\.ts$/i;
/** Test code: its definitions are never targets of name-only call resolution. */
const TEST_PATH = /(^|\/)(__tests__|__mocks__|tests?|spec|specs)\/|[._-](test|spec|tests)\.[a-z]+$/i;
/** A line this long is minified or generated, whatever the path says. */
const MINIFIED_LINE_CHARS = 2_000;

export class CodeIndex {
  readonly root: string;
  private files = new Map<string, FileRecord>();
  readonly nodes = new Map<string, EntityNode>();
  private outEdges = new Map<string, Edge[]>();
  private inEdges = new Map<string, Edge[]>();
  private byName = new Map<string, string[]>();
  private bm25 = new Bm25();
  private ranks = new Map<string, number>();
  private lastRefreshAt = 0;
  builtAt = 0;

  private constructor(root: string) {
    this.root = resolve(root);
  }

  static cachePath(root: string): string {
    const hash = createHash('sha256').update(resolve(root)).digest('hex').slice(0, 16);
    return join(dataDir(), 'projects', hash, 'code-index.json');
  }

  /** Load the cache (when present) and bring it up to date. */
  static async open(root: string, opts: { onProgress?: (done: number, total: number) => void } = {}): Promise<CodeIndex> {
    const index = new CodeIndex(root);
    tracedSync('index.loadCache', () => index.loadCache());
    await traced('index.open.refresh', () => index.refresh(opts));
    return index;
  }

  // ── build ──────────────────────────────────────────────────────────────

  private loadCache(): void {
    try {
      const path = CodeIndex.cachePath(this.root);
      if (!existsSync(path)) return;
      const raw = JSON.parse(readFileSync(path, 'utf8')) as CacheFile;
      if (raw.version !== INDEX_VERSION || raw.root !== this.root) return;
      for (const [rel, rec] of Object.entries(raw.files)) this.files.set(rel, rec);
    } catch {
      this.files.clear();
    }
  }

  private saveCache(): void {
    try {
      const path = CodeIndex.cachePath(this.root);
      mkdirSync(dirname(path), { recursive: true });
      const payload: CacheFile = { version: INDEX_VERSION, root: this.root, files: Object.fromEntries(this.files) };
      const tmp = `${path}.tmp`;
      writeFileSync(tmp, JSON.stringify(payload));
      renameSync(tmp, path);
    } catch {
      /* a missing cache only costs a rebuild next time */
    }
  }

  /** Files worth indexing: code with a grammar we ship, plus text files. */
  private enumerate(): string[] {
    const out: string[] = [];
    for (const rel of listProjectFiles(this.root)) {
      if (rel.split('/').some((seg) => NOISE_DIRS.has(seg))) continue;
      const lang = languageForPath(rel);
      if ((lang && hasGrammar(lang)) || isTextPath(rel)) out.push(rel);
      if (out.length >= MAX_FILES) break;
    }
    return out;
  }

  /**
   * Stat every candidate file, re-extract the ones that changed, drop the ones
   * that vanished, rebuild the graph. Cheap when nothing changed (a stat pass).
   * `force` skips the throttle and re-lists the project (new files appear at
   * once instead of after the file-list cache expires); unchanged files are
   * never re-parsed.
   */
  async refresh(opts: { onProgress?: (done: number, total: number) => void; force?: boolean } = {}): Promise<RefreshStats> {
    const started = Date.now();
    if (!opts.force && this.builtAt > 0 && started - this.lastRefreshAt < MIN_REFRESH_INTERVAL_MS) {
      return { added: 0, changed: 0, removed: 0, total: this.files.size, ms: 0 };
    }
    this.lastRefreshAt = started;
    if (opts.force || this.builtAt > 0) invalidateProjectFiles(this.root);
    const listed = this.enumerate();
    const seen = new Set<string>();
    const work: Array<{ rel: string; lang?: LanguageId; text: boolean; mtimeMs: number; size: number }> = [];
    let added = 0;
    let changed = 0;
    for (const rel of listed) {
      let st: ReturnType<typeof statSync>;
      try {
        st = statSync(join(this.root, rel));
      } catch {
        continue;
      }
      if (!st.isFile()) continue;
      seen.add(rel);
      const rec = this.files.get(rel);
      if (rec && rec.mtimeMs === st.mtimeMs && rec.size === st.size) continue;
      if (rec) changed += 1;
      else added += 1;
      const lang = languageForPath(rel) ?? undefined;
      work.push({ rel, lang, text: !lang && isTextPath(rel), mtimeMs: st.mtimeMs, size: st.size });
    }
    let removed = 0;
    for (const rel of [...this.files.keys()]) {
      if (!seen.has(rel)) {
        this.files.delete(rel);
        removed += 1;
      }
    }
    let done = 0;
    for (const w of work) {
      const rec: FileRecord = { mtimeMs: w.mtimeMs, size: w.size };
      if (w.size <= MAX_FILE_BYTES) {
        try {
          const buf = readFileSync(join(this.root, w.rel));
          if (!looksBinary(buf)) {
            const text = buf.toString('utf8');
            if (w.lang) {
              rec.lang = w.lang;
              if (looksGenerated(w.rel, text)) rec.generated = true;
              else rec.symbols = await extractSymbols(w.lang, text);
            } else if (w.text) {
              rec.text = true;
              rec.head = text.slice(0, TEXT_HEAD_BYTES);
            }
          }
        } catch {
          /* unreadable now; recorded as an empty file, retried when it changes */
        }
      }
      this.files.set(w.rel, rec);
      done += 1;
      if (opts.onProgress && (done % 25 === 0 || done === work.length)) opts.onProgress(done, work.length);
    }
    if (added + changed + removed > 0 || this.builtAt === 0) {
      tracedSync('index.rebuildGraph', () => this.rebuildGraph());
      this.builtAt = Date.now();
      if (added + changed + removed > 0) tracedSync('index.saveCache', () => this.saveCache());
    }
    return { added, changed, removed, total: this.files.size, ms: Date.now() - started };
  }

  private rebuildGraph(): void {
    this.nodes.clear();
    this.outEdges.clear();
    this.inEdges.clear();
    this.byName.clear();
    const bm25 = new Bm25();
    const fileSet = new Set(this.files.keys());
    // Module (namespace) name → files declaring it, for C#/Java-style imports.
    const moduleFiles = new Map<string, string[]>();
    // Def nodes by file, in line order, for reference resolution.
    const defsByFile = new Map<string, EntityNode[]>();

    for (const [rel, rec] of this.files) {
      this.ensureDirNodes(rel);
      const fileNode: EntityNode = {
        id: rel,
        kind: rec.text ? 'textfile' : 'file',
        name: rel.slice(rel.lastIndexOf('/') + 1),
        path: rel,
        fqn: rel,
        lang: rec.lang,
      };
      this.addNode(fileNode);
      this.addEdge(dirIdOf(rel), rel, 'contains');
      const tokens = [...tokenize(rel)];
      if (rec.head) tokens.push(...tokenize(rec.head).slice(0, 200));
      const defs = rec.symbols?.defs ?? [];
      const defNodes = this.addDefNodes(rel, rec.lang, defs);
      defsByFile.set(rel, defNodes);
      for (const d of defNodes) {
        if (d.kind === 'module') {
          const list = moduleFiles.get(d.name) ?? [];
          list.push(rel);
          moduleFiles.set(d.name, list);
        }
        tokens.push(...tokenize(d.name));
      }
      bm25.add(rel, tokens);
    }

    // Imports.
    for (const [rel, rec] of this.files) {
      for (const spec of rec.symbols?.imports ?? []) {
        const target = this.resolveImportTarget(spec, rel, fileSet, moduleFiles);
        for (const t of target) if (t !== rel) this.addEdge(rel, t, 'imports');
      }
    }

    // References: calls/constructions → invokes, inherit → inherits.
    for (const [rel, rec] of this.files) {
      const refs = rec.symbols?.refs ?? [];
      if (refs.length === 0) continue;
      const local = defsByFile.get(rel) ?? [];
      const imported = (this.outEdges.get(rel) ?? []).filter((e) => e.kind === 'imports').map((e) => e.to);
      const seen = new Set<string>();
      for (const ref of refs) {
        const from = enclosingDef(local, ref.line)?.id ?? rel;
        const { ids: targets, weak } = this.resolveName(ref.name, rel, local, imported, defsByFile);
        for (const t of targets) {
          const kind: EdgeKind = ref.kind === 'inherit' ? 'inherits' : 'invokes';
          const key = `${from}|${t}|${kind}`;
          if (seen.has(key) || t === from) continue;
          seen.add(key);
          this.addEdge(from, t, kind, weak);
        }
      }
    }

    // BM25 over symbols too.
    for (const node of this.nodes.values()) {
      if (node.kind === 'dir' || node.kind === 'file' || node.kind === 'textfile') continue;
      bm25.add(node.id, [...tokenize(node.name), ...tokenize(node.fqn), ...tokenize(node.path), ...tokenize(node.signature ?? '')]);
    }
    bm25.finish();
    this.bm25 = bm25;
    this.ranks = this.computeFileRanks(null);
  }

  private ensureDirNodes(rel: string): void {
    const parts = rel.split('/');
    let path = '';
    for (let i = 0; i < parts.length - 1; i++) {
      const next = path ? `${path}/${parts[i]}` : parts[i]!;
      const id = `dir:${next}`;
      if (!this.nodes.has(id)) {
        this.addNode({ id, kind: 'dir', name: parts[i]!, path: next, fqn: next });
        this.addEdge(path ? `dir:${path}` : 'dir:', id, 'contains');
      }
      path = next;
    }
    if (!this.nodes.has('dir:')) this.addNode({ id: 'dir:', kind: 'dir', name: '.', path: '', fqn: '' });
  }

  private addDefNodes(rel: string, lang: LanguageId | undefined, defs: SymbolDef[]): EntityNode[] {
    // defs come sorted by start offset, outer first; rebuild containment for fqn.
    const out: EntityNode[] = [];
    const stack: Array<{ def: SymbolDef; node: EntityNode }> = [];
    const usedIds = new Set<string>();
    for (const d of defs) {
      while (stack.length > 0 && stack[stack.length - 1]!.def.endIndex <= d.startIndex) stack.pop();
      let container: EntityNode | undefined;
      for (let i = stack.length - 1; i >= 0; i--) {
        const s = stack[i]!;
        if (s.def.startIndex <= d.startIndex && s.def.endIndex >= d.endIndex) {
          container = s.node;
          break;
        }
      }
      const fqn = container ? `${container.fqn}.${d.name}` : d.name;
      let id = `${rel}::${fqn}`;
      if (usedIds.has(id)) id = `${id}@${d.startLine}`;
      usedIds.add(id);
      const node: EntityNode = {
        id,
        kind: d.kind,
        name: d.name,
        path: rel,
        fqn,
        startLine: d.startLine,
        endLine: d.endLine,
        parent: container?.id,
        signature: d.signature,
        lang,
      };
      this.addNode(node);
      this.addEdge(container ? container.id : rel, id, 'contains');
      out.push(node);
      stack.push({ def: d, node });
    }
    return out;
  }

  private addNode(node: EntityNode): void {
    this.nodes.set(node.id, node);
    if (node.kind !== 'dir') {
      const key = node.name.toLowerCase();
      const list = this.byName.get(key) ?? [];
      list.push(node.id);
      this.byName.set(key, list);
    }
  }

  private addEdge(from: string, to: string, kind: EdgeKind, weak = false): void {
    const e: Edge = weak ? { from, to, kind, weak } : { from, to, kind };
    const out = this.outEdges.get(from) ?? [];
    out.push(e);
    this.outEdges.set(from, out);
    const inn = this.inEdges.get(to) ?? [];
    inn.push(e);
    this.inEdges.set(to, inn);
  }

  private resolveImportTarget(spec: string, importerRel: string, fileSet: Set<string>, moduleFiles: Map<string, string[]>): string[] {
    const direct = resolveImport(spec, importerRel, fileSet);
    if (direct) return [direct];
    // C-style relative include.
    if (spec.startsWith('.') || spec.endsWith('.h') || spec.endsWith('.hpp')) {
      const dir = importerRel.includes('/') ? importerRel.slice(0, importerRel.lastIndexOf('/')) : '';
      const cand = normalizePath(dir ? `${dir}/${spec}` : spec);
      if (fileSet.has(cand)) return [cand];
    }
    // Namespace / package style ("using Automax.App.Services", "import a.b.C").
    const mod = spec.replace(/^static\s+/, '').replace(/[;\s]/g, '');
    const byModule = moduleFiles.get(mod);
    if (byModule) return byModule.slice(0, 20);
    // Java-style dotted path to a file.
    const dotted = mod.replace(/\./g, '/');
    for (const ext of ['.java', '.kt', '.scala']) {
      if (fileSet.has(`${dotted}${ext}`)) return [`${dotted}${ext}`];
      for (const f of fileSet) {
        if (f.endsWith(`/${dotted}${ext}`)) return [f];
      }
      break;
    }
    return [];
  }

  private resolveName(
    name: string,
    rel: string,
    local: EntityNode[],
    imported: string[],
    defsByFile: Map<string, EntityNode[]>,
  ): { ids: string[]; weak: boolean } {
    const lower = name.toLowerCase();
    const same = local.filter((d) => d.name.toLowerCase() === lower);
    if (same.length > 0) return { ids: same.map((d) => d.id), weak: false };
    const viaImports: string[] = [];
    for (const f of imported) {
      for (const d of defsByFile.get(f) ?? []) if (d.name.toLowerCase() === lower) viaImports.push(d.id);
    }
    if (viaImports.length > 0) return { ids: viaImports, weak: false };
    // Name-only fallback: a guess across the project, so it never points into
    // test code (helpers named `setup`, `service`, … would attract everything)
    // and never feeds file ranking.
    const global = (this.byName.get(lower) ?? []).filter((id) => {
      const n = this.nodes.get(id);
      return n && n.kind !== 'file' && n.kind !== 'textfile' && n.kind !== 'dir' && n.path !== rel && !TEST_PATH.test(n.path);
    });
    return { ids: global.length > 0 && global.length <= MAX_GLOBAL_CANDIDATES ? global : [], weak: true };
  }

  // ── queries ────────────────────────────────────────────────────────────

  entity(id: string): EntityNode | undefined {
    return this.nodes.get(id);
  }

  /** Resolve a user-facing reference: an id, "path", "path::fqn", "path#name", "path:line", or a bare name. */
  resolve(ref: string): EntityNode[] {
    const r = ref.trim().replace(/\\/g, '/');
    const direct = this.nodes.get(r);
    if (direct) return [direct];
    const hash = r.indexOf('#');
    if (hash > 0) {
      const path = r.slice(0, hash);
      const name = r.slice(hash + 1).toLowerCase();
      return this.symbolsIn(path).filter((n) => n.name.toLowerCase() === name || n.fqn.toLowerCase() === name);
    }
    const lineRef = /^(.+):(\d+)$/.exec(r);
    if (lineRef && this.nodes.has(lineRef[1]!)) {
      const line = Number(lineRef[2]);
      const inner = enclosingDef(this.symbolsIn(lineRef[1]!), line);
      return inner ? [inner] : [this.nodes.get(lineRef[1]!)!];
    }
    const byName = (this.byName.get(r.toLowerCase()) ?? []).map((id) => this.nodes.get(id)!).filter(Boolean);
    if (byName.length > 0) return byName;
    // fqn match anywhere
    const lower = r.toLowerCase();
    const out: EntityNode[] = [];
    for (const n of this.nodes.values()) {
      if (n.fqn.toLowerCase() === lower) out.push(n);
      if (out.length >= 20) break;
    }
    return out;
  }

  symbolsIn(path: string): EntityNode[] {
    const out: EntityNode[] = [];
    for (const n of this.nodes.values()) if (n.path === path && n.startLine !== undefined) out.push(n);
    return out.sort((a, b) => a.startLine! - b.startLine!);
  }

  edgesFrom(id: string, kinds?: EdgeKind[]): Edge[] {
    const list = this.outEdges.get(id) ?? [];
    return kinds ? list.filter((e) => kinds.includes(e.kind)) : list;
  }

  edgesTo(id: string, kinds?: EdgeKind[]): Edge[] {
    const list = this.inEdges.get(id) ?? [];
    return kinds ? list.filter((e) => kinds.includes(e.kind)) : list;
  }

  /**
   * Rank entities for a query: exact names first, then names/paths that
   * contain the query, then BM25 over identifier/path/signature tokens.
   */
  search(query: string, opts: { limit?: number; kinds?: NodeKind[]; pathPrefix?: string } = {}): SearchHit[] {
    const limit = opts.limit ?? 20;
    const q = query.trim();
    const lower = q.toLowerCase();
    const terms = tokenize(q);
    const scores = new Map<string, { score: number; why: string }>();
    const bump = (id: string, score: number, why: string): void => {
      const cur = scores.get(id);
      if (!cur || cur.score < score) scores.set(id, { score, why });
    };
    for (const id of this.byName.get(lower) ?? []) bump(id, 100, 'exact name');
    if (lower.length >= 2) {
      for (const n of this.nodes.values()) {
        if (n.kind === 'dir') continue;
        const name = n.name.toLowerCase();
        if (name === lower) continue;
        if (name.startsWith(lower)) bump(n.id, 60, 'name prefix');
        else if (name.includes(lower)) bump(n.id, 45, 'name contains');
        else if (n.fqn.toLowerCase().includes(lower)) bump(n.id, 40, 'qualified name contains');
        else if (n.path.toLowerCase().includes(lower)) bump(n.id, 25, 'path contains');
      }
    }
    if (terms.length > 0) {
      // BM25 scores land in a 20–38 band scaled by the best hit, so keyword
      // matches never outrank a name match but keep their relative order.
      const ranked = this.bm25.query(terms, 200);
      const best = ranked.length > 0 ? ranked[0]!.score : 1;
      for (const { id, score } of ranked) bump(id, 20 + 18 * (score / best), 'keyword match');
    }
    const pathLike = /[\/.]/.test(q) && !/\s/.test(q);
    const phrase = /\s/.test(q.trim());
    const uniqTerms = [...new Set(terms)];
    let hits: SearchHit[] = [];
    for (const [id, s] of scores) {
      const node = this.nodes.get(id);
      if (!node) continue;
      if (opts.kinds && !opts.kinds.includes(node.kind)) continue;
      if (opts.pathPrefix && !node.path.startsWith(opts.pathPrefix)) continue;
      let score = s.score;
      const isFile = node.kind === 'file' || node.kind === 'textfile';
      // Definitions beat files for a symbol-looking query; files win for
      // path-looking ones; a phrase ("login page") treats both alike.
      if (isFile) score += pathLike ? 8 : phrase ? 0 : -6;
      // Every query word inside the entity's own name: the strongest keyword
      // signal there is ("login page" → LoginPage).
      if (!isFile && uniqTerms.length > 1) {
        const own = new Set(tokenize(node.name));
        if (uniqTerms.every((t) => own.has(t))) score += 12;
      }
      score += (this.ranks.get(node.path) ?? 0) * 20;
      hits.push({ node, score, why: s.why });
    }
    hits.sort((a, b) => b.score - a.score || a.node.path.localeCompare(b.node.path) || (a.node.startLine ?? 0) - (b.node.startLine ?? 0));
    hits = hits.slice(0, limit);
    return hits;
  }

  /** BFS over the graph from `ids`; returns the visited nodes and the edges walked. */
  traverse(
    ids: string[],
    opts: { direction?: 'in' | 'out' | 'both'; hops?: number; kinds?: EdgeKind[]; maxNodes?: number } = {},
  ): { nodes: EntityNode[]; edges: Edge[]; truncated: boolean } {
    const direction = opts.direction ?? 'both';
    const hops = Math.max(1, Math.min(opts.hops ?? 1, 3));
    const maxNodes = opts.maxNodes ?? 60;
    const kinds = opts.kinds ?? ['imports', 'invokes', 'inherits'];
    const visited = new Set<string>(ids.filter((id) => this.nodes.has(id)));
    const edges: Edge[] = [];
    let frontier = [...visited];
    let truncated = false;
    for (let h = 0; h < hops && frontier.length > 0; h++) {
      const next: string[] = [];
      for (const id of frontier) {
        const around: Edge[] = [];
        if (direction !== 'in') around.push(...this.edgesFrom(id, kinds));
        if (direction !== 'out') around.push(...this.edgesTo(id, kinds));
        for (const e of around) {
          const other = e.from === id ? e.to : e.from;
          edges.push(e);
          if (!visited.has(other)) {
            if (visited.size >= maxNodes) {
              truncated = true;
              continue;
            }
            visited.add(other);
            next.push(other);
          }
        }
      }
      frontier = next;
    }
    return { nodes: [...visited].map((id) => this.nodes.get(id)!), edges, truncated };
  }

  /** The source lines of an entity (a symbol's span, or a file's head), numbered. */
  source(node: EntityNode, opts: { maxLines?: number; context?: number } = {}): { text: string; startLine: number; endLine: number; truncated: boolean } | null {
    const maxLines = opts.maxLines ?? 200;
    let text: string;
    try {
      text = readFileSync(join(this.root, node.path), 'utf8');
    } catch {
      return null;
    }
    const lines = text.split(/\r?\n/);
    if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
    const isSpan = node.startLine !== undefined && node.endLine !== undefined;
    const ctx = isSpan ? (opts.context ?? 0) : 0;
    const start = Math.max(1, (node.startLine ?? 1) - ctx);
    const fullEnd = isSpan ? Math.min(lines.length, node.endLine! + ctx) : lines.length;
    const cappedEnd = Math.min(fullEnd, start + maxLines - 1);
    const width = String(cappedEnd).length;
    const out = lines
      .slice(start - 1, cappedEnd)
      .map((l, i) => `${String(start + i).padStart(width)}  ${l}`)
      .join('\n');
    return { text: out, startLine: start, endLine: cappedEnd, truncated: cappedEnd < fullEnd };
  }

  /** File importance (PageRank over imports + invokes between files), optionally personalized. */
  fileRanks(personalization: Map<string, number> | null = null): Map<string, number> {
    return personalization ? this.computeFileRanks(personalization) : this.ranks;
  }

  private computeFileRanks(personalization: Map<string, number> | null): Map<string, number> {
    const files = [...this.files.keys()];
    const edges = new Map<string, Set<string>>();
    for (const list of this.outEdges.values()) {
      for (const e of list) {
        if (e.kind === 'contains' || e.weak) continue;
        const a = this.nodes.get(e.from)?.path;
        const b = this.nodes.get(e.to)?.path;
        if (!a || !b || a === b) continue;
        const s = edges.get(a) ?? new Set<string>();
        s.add(b);
        edges.set(a, s);
      }
    }
    return pageRankPersonalized(files, edges, personalization);
  }

  stats(): { files: number; symbols: number; edges: number; builtAt: number; textFiles: number } {
    let symbols = 0;
    let textFiles = 0;
    for (const n of this.nodes.values()) {
      if (n.kind === 'textfile') textFiles += 1;
      else if (n.kind !== 'dir' && n.kind !== 'file') symbols += 1;
    }
    let edges = 0;
    for (const l of this.outEdges.values()) edges += l.length;
    return { files: this.files.size, symbols, edges, builtAt: this.builtAt, textFiles };
  }

  /** Definitions in a file, outline style, for skeleton rendering. */
  outline(path: string): EntityNode[] {
    return this.symbolsIn(path);
  }

  filePaths(): string[] {
    return [...this.files.keys()];
  }
}

// ── helpers ─────────────────────────────────────────────────────────────────

function dirIdOf(rel: string): string {
  const i = rel.lastIndexOf('/');
  return i < 0 ? 'dir:' : `dir:${rel.slice(0, i)}`;
}

function enclosingDef(defs: EntityNode[], line: number): EntityNode | undefined {
  let best: EntityNode | undefined;
  for (const d of defs) {
    if (d.startLine !== undefined && d.endLine !== undefined && d.startLine <= line && d.endLine >= line) {
      if (!best || d.endLine - d.startLine < best.endLine! - best.startLine!) best = d;
    }
  }
  return best;
}

function normalizePath(p: string): string {
  const parts: string[] = [];
  for (const seg of p.replace(/\\/g, '/').split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') parts.pop();
    else parts.push(seg);
  }
  return parts.join('/');
}

function looksBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

/** Vendored, minified or generated code by path, or by a minified-looking head. */
export function looksGenerated(rel: string, text: string): boolean {
  if (GENERATED_PATH.test(rel)) return true;
  let start = 0;
  for (let i = 0; i < 20 && start < text.length; i++) {
    let nl = text.indexOf('\n', start);
    if (nl < 0) nl = text.length;
    if (nl - start > MINIFIED_LINE_CHARS) return true;
    start = nl + 1;
  }
  return false;
}

export function isTestPath(rel: string): boolean {
  return TEST_PATH.test(rel);
}

/** Identifier-aware tokenizer: splits paths, snake_case and camelCase, lowercases. */
export function tokenize(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split(/[^A-Za-z0-9]+/)) {
    if (raw.length === 0) continue;
    const parts = raw
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
      .split(' ');
    if (parts.length > 1) out.push(raw.toLowerCase());
    for (const p of parts) if (p.length >= 2) out.push(p.toLowerCase());
  }
  return out;
}

/** Small BM25 over token arrays; enough for a few hundred thousand tokens. */
export class Bm25 {
  private readonly docs = new Map<string, Map<string, number>>();
  private readonly lengths = new Map<string, number>();
  private readonly df = new Map<string, number>();
  private avgLen = 1;
  private readonly k1 = 1.2;
  private readonly b = 0.75;

  add(id: string, tokens: string[]): void {
    const tf = new Map<string, number>();
    for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
    this.docs.set(id, tf);
    this.lengths.set(id, tokens.length);
    for (const t of tf.keys()) this.df.set(t, (this.df.get(t) ?? 0) + 1);
  }

  finish(): void {
    let total = 0;
    for (const l of this.lengths.values()) total += l;
    this.avgLen = this.lengths.size > 0 ? total / this.lengths.size : 1;
  }

  query(terms: string[], limit = 50): Array<{ id: string; score: number }> {
    const n = this.docs.size;
    if (n === 0) return [];
    const scores = new Map<string, number>();
    const uniq = [...new Set(terms)];
    for (const term of uniq) {
      const df = this.df.get(term);
      if (!df) continue;
      const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5));
      for (const [id, tf] of this.docs) {
        const f = tf.get(term);
        if (!f) continue;
        const len = this.lengths.get(id) ?? 1;
        const s = idf * ((f * (this.k1 + 1)) / (f + this.k1 * (1 - this.b + (this.b * len) / this.avgLen)));
        scores.set(id, (scores.get(id) ?? 0) + s);
      }
    }
    return [...scores.entries()]
      .map(([id, score]) => ({ id, score }))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }
}

/** PageRank with an optional personalization vector (teleport toward chosen files). */
export function pageRankPersonalized(
  nodes: string[],
  edges: Map<string, Set<string>>,
  personalization: Map<string, number> | null,
  iterations = 20,
  damping = 0.85,
): Map<string, number> {
  const n = nodes.length;
  const rank = new Map<string, number>();
  if (n === 0) return rank;
  let teleport = new Map<string, number>();
  let pSum = 0;
  if (personalization) {
    for (const [k, v] of personalization) if (v > 0 && nodes.includes(k)) pSum += v;
  }
  if (personalization && pSum > 0) {
    for (const [k, v] of personalization) if (v > 0) teleport.set(k, v / pSum);
  } else {
    teleport = new Map(nodes.map((id) => [id, 1 / n]));
  }
  for (const id of nodes) rank.set(id, 1 / n);
  const index = new Set(nodes);
  for (let it = 0; it < iterations; it++) {
    const next = new Map<string, number>();
    let dangling = 0;
    for (const id of nodes) {
      const out = edges.get(id);
      const outs = out ? [...out].filter((t) => index.has(t)) : [];
      const r = rank.get(id) ?? 0;
      if (outs.length === 0) {
        dangling += r;
        continue;
      }
      const share = r / outs.length;
      for (const t of outs) next.set(t, (next.get(t) ?? 0) + share);
    }
    for (const id of nodes) {
      const tele = teleport.get(id) ?? 0;
      const flow = (next.get(id) ?? 0) + dangling * tele;
      rank.set(id, (1 - damping) * tele + damping * flow);
    }
  }
  return rank;
}
