import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SearchEntityTool } from '../../src/tools/searchEntity.js';
import { TraverseGraphTool } from '../../src/tools/traverseGraph.js';
import { RetrieveEntityTool } from '../../src/tools/retrieveEntity.js';
import { resetIndex } from '../../src/index/IndexManager.js';
import type { SessionContext } from '../../src/session/SessionContext.js';
import type { ToolExecutionContext } from '../../src/tools/types.js';

let root: string;
let dataDir: string;

function write(rel: string, text: string): void {
  const abs = join(root, rel);
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, text);
}

function ctx(): ToolExecutionContext {
  const session: SessionContext = {
    sessionId: 't',
    projectRoot: root,
    dataDir: root,
    sessionDir: root,
    model: { provider: 'xai', model: 'grok-code-fast-1' },
    startedAt: new Date().toISOString(),
    mode: 'autocode',
  };
  return { session };
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'autocode-indextools-'));
  dataDir = mkdtempSync(join(tmpdir(), 'autocode-indextools-data-'));
  process.env.AUTOCODE_DATA_DIR = dataDir;
  write(
    'src/export/ExportButton.tsx',
    [
      "import { buildCsv } from '../csv/build.js';",
      'export function ExportButton(): string {',
      '  return buildCsv([]);',
      '}',
    ].join('\n'),
  );
  write('src/csv/build.ts', 'export function buildCsv(rows: string[][]): string {\n  return rows.map((r) => r.join(",")).join("\\n");\n}\n');
  write('src/other.ts', 'export function unrelated(): void {}\n');
});

afterAll(() => {
  resetIndex(root);
  rmSync(root, { recursive: true, force: true });
  rmSync(dataDir, { recursive: true, force: true });
  delete process.env.AUTOCODE_DATA_DIR;
});

describe('search_entity', () => {
  it('ranks the obvious entity first and shows signatures in preview view', async () => {
    const r = await new SearchEntityTool().execute({ query: 'export button' }, ctx());
    expect(r.isError).toBeFalsy();
    expect(r.content.split('\n')[1]).toContain('src/export/ExportButton.tsx');
    expect(r.content).toContain('function ExportButton');
    const hits = (r.metadata as { hits: Array<{ id: string }> }).hits;
    expect(hits[0]!.id).toMatch(/ExportButton/);
  });

  it('filters by kinds and path, and reports no matches cleanly', async () => {
    const files = await new SearchEntityTool().execute({ query: 'build', kinds: ['file'], view: 'fold' }, ctx());
    expect(files.content).toContain('src/csv/build.ts  file');
    expect(files.content).not.toContain('function buildCsv');
    const under = await new SearchEntityTool().execute({ query: 'buildCsv', path: 'src/export' }, ctx());
    // buildCsv is only called from src/export; its definition lives elsewhere.
    expect(under.content).not.toContain('src/csv/build.ts');
    const none = await new SearchEntityTool().execute({ query: 'zzzz-nothing' }, ctx());
    expect(none.isError).toBeFalsy();
    expect(none.content).toContain('No entities match');
    const bad = await new SearchEntityTool().execute({ query: 'x', kinds: ['widget'] }, ctx());
    expect(bad.isError).toBe(true);
  });
});

describe('traverse_graph', () => {
  it('walks callers and imports from loose references', async () => {
    const r = await new TraverseGraphTool().execute({ ids: ['src/csv/build.ts#buildCsv'], direction: 'in' }, ctx());
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain('called by (1):');
    expect(r.content).toContain('src/export/ExportButton.tsx:2-4  function ExportButton');
    const out = await new TraverseGraphTool().execute({ ids: ['src\\export\\ExportButton.tsx'], direction: 'out', kinds: ['imports'] }, ctx());
    expect(out.content).toContain('imports (1):');
    expect(out.content).toContain('src/csv/build.ts');
  });

  it('reports unresolved and bad inputs', async () => {
    const r = await new TraverseGraphTool().execute({ ids: ['nope/missing.ts'] }, ctx());
    expect(r.isError).toBe(true);
    expect(r.content).toContain('not in the index');
    const bad = await new TraverseGraphTool().execute({ ids: ['src/other.ts'], kinds: ['teleports'] }, ctx());
    expect(bad.isError).toBe(true);
  });
});

describe('retrieve_entity', () => {
  it('returns a symbol span with line numbers and a file outline', async () => {
    const r = await new RetrieveEntityTool().execute({ ids: ['buildCsv', 'src/export/ExportButton.tsx'] }, ctx());
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain('src/csv/build.ts:1-3  function buildCsv');
    expect(r.content).toContain('1  export function buildCsv');
    expect(r.content).toContain('src/export/ExportButton.tsx\n  2  function ExportButton');
    const src = await new RetrieveEntityTool().execute({ ids: ['src/export/ExportButton.tsx'], source: true, max_lines: 2 }, ctx());
    expect(src.content).toContain("1  import { buildCsv }");
    expect(src.content).toContain('truncated at line 2');
  });

  it('resolves path:line to the innermost definition', async () => {
    const r = await new RetrieveEntityTool().execute({ ids: ['src/export/ExportButton.tsx:3'], context: 1 }, ctx());
    expect(r.content).toContain('function ExportButton');
    expect(r.content).toContain("1  import");
  });
});
