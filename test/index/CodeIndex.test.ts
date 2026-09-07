import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodeIndex, tokenize, pageRankPersonalized, Bm25, looksGenerated, isTestPath } from '../../src/index/CodeIndex.js';

let root: string;
let dataDir: string;
let index: CodeIndex;

function write(rel: string, text: string): void {
  const abs = join(root, rel);
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, text);
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'autocode-index-'));
  dataDir = mkdtempSync(join(tmpdir(), 'autocode-index-data-'));
  process.env.AUTOCODE_DATA_DIR = dataDir;
  write(
    'src/app.ts',
    [
      "import { parseArgs } from './util/args.js';",
      "import { Base } from './base.js';",
      'export class App extends Base {',
      '  render(): void { const a = parseArgs([]); this.paint(a); }',
      '  paint(a: unknown): void { console.log(a); }',
      '}',
      'export function main(): void { new App().render(); }',
    ].join('\n'),
  );
  write('src/base.ts', 'export class Base {\n  paint(a: unknown): void {}\n}\n');
  write(
    'src/util/args.ts',
    'export interface Args { mode?: string }\nexport function parseArgs(argv: string[]): Args {\n  return {};\n}\n',
  );
  write('src/orphan.ts', 'export function lonely(): number { return 1; }\n');
  write('README.md', '# Demo project\n\nSetup: run `npm install`. The export button lives in app.ts.\n');
  write('node_modules/dep/index.js', 'module.exports = 1;');
  write('src/Program.cs', 'namespace Demo { class Materializer { public void Materialize() { Helper(); } void Helper() {} } }\n');
  index = await CodeIndex.open(root);
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(dataDir, { recursive: true, force: true });
  delete process.env.AUTOCODE_DATA_DIR;
});

describe('CodeIndex build', () => {
  it('indexes code files, text files and directories, skipping noise dirs', () => {
    const stats = index.stats();
    expect(stats.files).toBe(6);
    expect(stats.textFiles).toBe(1);
    expect(index.entity('src/app.ts')?.kind).toBe('file');
    expect(index.entity('README.md')?.kind).toBe('textfile');
    expect(index.entity('dir:src/util')?.kind).toBe('dir');
    expect(index.entity('node_modules/dep/index.js')).toBeUndefined();
  });

  it('creates symbol nodes with qualified names, spans and parents', () => {
    const render = index.entity('src/app.ts::App.render');
    expect(render).toMatchObject({ kind: 'method', name: 'render', fqn: 'App.render', path: 'src/app.ts', startLine: 4, endLine: 4, parent: 'src/app.ts::App' });
    expect(index.entity('src/app.ts::main')?.kind).toBe('function');
    expect(index.entity('src/util/args.ts::Args')?.kind).toBe('interface');
    // C# nesting on a single line still resolves by offsets.
    expect(index.entity('src/Program.cs::Demo.Materializer.Materialize')?.kind).toBe('method');
  });

  it('builds import, invoke, inherit and contains edges', () => {
    const imports = index.edgesFrom('src/app.ts', ['imports']).map((e) => e.to).sort();
    expect(imports).toEqual(['src/base.ts', 'src/util/args.ts']);
    const inherits = index.edgesFrom('src/app.ts::App', ['inherits']).map((e) => e.to);
    expect(inherits).toEqual(['src/base.ts::Base']);
    const calls = index.edgesFrom('src/app.ts::App.render', ['invokes']).map((e) => e.to).sort();
    // parseArgs resolves through the import; paint resolves in the same file first.
    expect(calls).toEqual(['src/app.ts::App.paint', 'src/util/args.ts::parseArgs']);
    const callers = index.edgesTo('src/util/args.ts::parseArgs', ['invokes']).map((e) => e.from);
    expect(callers).toEqual(['src/app.ts::App.render']);
    const contains = index.edgesFrom('src/app.ts::App', ['contains']).map((e) => e.to).sort();
    expect(contains).toEqual(['src/app.ts::App.paint', 'src/app.ts::App.render']);
    expect(index.edgesFrom('dir:src', ['contains']).map((e) => e.to)).toContain('src/app.ts');
  });
});

describe('CodeIndex queries', () => {
  it('search ranks exact names first, then contains, then keywords', () => {
    const hits = index.search('parseArgs');
    expect(hits[0]!.node.id).toBe('src/util/args.ts::parseArgs');
    expect(hits[0]!.why).toBe('exact name');
    const partial = index.search('pars');
    expect(partial.map((h) => h.node.name)).toContain('parseArgs');
    const kw = index.search('export button');
    expect(kw.map((h) => h.node.id)).toContain('README.md');
  });

  it('search honors kinds and path filters', () => {
    const files = index.search('app', { kinds: ['file'] });
    expect(files.every((h) => h.node.kind === 'file')).toBe(true);
    expect(files[0]!.node.path).toBe('src/app.ts');
    const under = index.search('paint', { pathPrefix: 'src/base' });
    expect(under[0]!.node.id).toBe('src/base.ts::Base.paint');
    expect(under.every((h) => h.node.path.startsWith('src/base'))).toBe(true);
  });

  it('resolve accepts ids, paths, path#name, path:line and bare names', () => {
    expect(index.resolve('src/app.ts::App').length).toBe(1);
    expect(index.resolve('src\\app.ts')[0]!.id).toBe('src/app.ts');
    expect(index.resolve('src/app.ts#render')[0]!.id).toBe('src/app.ts::App.render');
    expect(index.resolve('src/app.ts:5')[0]!.id).toBe('src/app.ts::App.paint');
    expect(index.resolve('paint').map((n) => n.id).sort()).toEqual(['src/app.ts::App.paint', 'src/base.ts::Base.paint']);
    expect(index.resolve('nothing-here')).toEqual([]);
  });

  it('traverse walks in/out/both with hop and node caps', () => {
    const inward = index.traverse(['src/util/args.ts::parseArgs'], { direction: 'in' });
    expect(inward.nodes.map((n) => n.id)).toContain('src/app.ts::App.render');
    const out = index.traverse(['src/app.ts'], { direction: 'out', kinds: ['imports'] });
    expect(out.nodes.map((n) => n.id).sort()).toEqual(['src/app.ts', 'src/base.ts', 'src/util/args.ts']);
    const two = index.traverse(['src/app.ts::main'], { direction: 'out', hops: 2 });
    expect(two.nodes.map((n) => n.id)).toContain('src/util/args.ts::parseArgs');
    const capped = index.traverse(['src/app.ts'], { direction: 'both', hops: 3, maxNodes: 2 });
    expect(capped.truncated).toBe(true);
    expect(capped.nodes.length).toBeLessThanOrEqual(2);
  });

  it('source returns the numbered span with optional context', () => {
    const node = index.entity('src/app.ts::App.paint')!;
    const src = index.source(node)!;
    expect(src.startLine).toBe(5);
    expect(src.text).toBe('5  ' + '  paint(a: unknown): void { console.log(a); }');
    const withCtx = index.source(node, { context: 1 })!;
    expect(withCtx.startLine).toBe(4);
    expect(withCtx.endLine).toBe(6);
  });

  it('file ranks favor imported files and follow personalization', () => {
    const ranks = index.fileRanks();
    expect(ranks.get('src/util/args.ts')!).toBeGreaterThan(ranks.get('src/orphan.ts')!);
    const personal = index.fileRanks(new Map([['src/orphan.ts', 1]]));
    expect(personal.get('src/orphan.ts')!).toBeGreaterThan(personal.get('src/app.ts')!);
  });

  it('outline lists definitions in order', () => {
    expect(index.outline('src/app.ts').map((n) => n.fqn)).toEqual(['App', 'App.render', 'App.paint', 'main']);
  });
});

describe('CodeIndex cache and refresh', () => {
  it('writes a cache file and reloads from it', async () => {
    const path = CodeIndex.cachePath(root);
    expect(existsSync(path)).toBe(true);
    const raw = JSON.parse(readFileSync(path, 'utf8')) as { files: Record<string, unknown> };
    expect(Object.keys(raw.files).sort()).toContain('src/app.ts');
    const second = await CodeIndex.open(root);
    expect(second.stats().symbols).toBe(index.stats().symbols);
  });

  it('picks up added, changed and removed files incrementally', async () => {
    write('src/extra.ts', 'export function extra(): void { lonely(); }\n');
    const abs = join(root, 'src/orphan.ts');
    writeFileSync(abs, 'export function lonely(): number { return 2; }\nexport function second(): void {}\n');
    const future = new Date(Date.now() + 5000);
    utimesSync(abs, future, future);
    rmSync(join(root, 'src/base.ts'));
    const r = await index.refresh({ force: true });
    expect(r.added).toBe(1);
    expect(r.changed).toBe(1);
    expect(r.removed).toBe(1);
    // Right after a pass, a plain refresh is throttled to a no-op.
    const throttled = await index.refresh();
    expect(throttled.added + throttled.changed + throttled.removed).toBe(0);
    expect(throttled.ms).toBe(0);
    expect(index.entity('src/extra.ts::extra')).toBeDefined();
    expect(index.entity('src/orphan.ts::second')).toBeDefined();
    expect(index.entity('src/base.ts')).toBeUndefined();
    // The dangling inherits edge is gone with its target.
    expect(index.edgesFrom('src/app.ts::App', ['inherits'])).toEqual([]);
  });
});

describe('helpers', () => {
  it('tokenize splits paths, camelCase and snake_case', () => {
    expect(tokenize('src/TaskTreeRow.xaml.cs')).toEqual(['src', 'tasktreerow', 'task', 'tree', 'row', 'xaml', 'cs']);
    expect(tokenize('parse_args HTTPServer')).toEqual(['parse', 'args', 'httpserver', 'http', 'server']);
  });

  it('bm25 scores rarer terms higher', () => {
    const b = new Bm25();
    b.add('a', ['export', 'button', 'click']);
    b.add('b', ['export', 'csv']);
    b.add('c', ['export', 'pdf']);
    b.finish();
    const r = b.query(['export', 'button']);
    expect(r[0]!.id).toBe('a');
    expect(r[0]!.score).toBeGreaterThan(r[1]!.score);
  });

  it('recognizes generated and test paths', () => {
    expect(looksGenerated('public/vendor/markdown/milkdown-bundle.js', 'x')).toBe(true);
    expect(looksGenerated('public/fullcalendar.global.min.js', 'x')).toBe(true);
    expect(looksGenerated('src/types.d.ts', 'x')).toBe(true);
    expect(looksGenerated('src/app.ts', 'export const a = 1;\n')).toBe(false);
    expect(looksGenerated('src/blob.js', 'a'.repeat(5000))).toBe(true);
    expect(isTestPath('src/lib/repository.test.ts')).toBe(true);
    expect(isTestPath('tests/e2e/basic.ts')).toBe(true);
    expect(isTestPath('src/app/tests.ts')).toBe(false);
  });

  it('personalized pagerank teleports toward the seed', () => {
    const edges = new Map<string, Set<string>>([
      ['a', new Set(['b'])],
      ['b', new Set(['c'])],
      ['c', new Set(['a'])],
    ]);
    const plain = pageRankPersonalized(['a', 'b', 'c'], edges, null);
    expect(Math.abs(plain.get('a')! - plain.get('b')!)).toBeLessThan(1e-6);
    const seeded = pageRankPersonalized(['a', 'b', 'c'], edges, new Map([['c', 1]]));
    expect(seeded.get('c')!).toBeGreaterThan(seeded.get('b')!);
  });
});
