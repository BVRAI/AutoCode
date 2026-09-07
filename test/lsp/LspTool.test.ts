import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { LspTool, locate } from '../../src/tools/lsp.js';
import { discoverServer, parseCommandLine } from '../../src/lsp/LspClient.js';
import { shutdownLsp } from '../../src/lsp/LspManager.js';
import type { SessionContext } from '../../src/session/SessionContext.js';

let root: string;
const fake = resolve('test/lsp/fakeServer.mjs');
const savedOverride = process.env.AUTOCODE_LSP_TYPESCRIPT;

function session(): SessionContext {
  return { sessionId: 's', projectRoot: root, dataDir: join(root, 'data'), sessionDir: join(root, 'session'), model: { provider: 'xai', model: 'm' }, startedAt: new Date().toISOString(), mode: 'autocode' };
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'autocode-lsp-'));
  const file = join(root, 'src', 'math.ts');
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(
    file,
    ['export function add(a: number, b: number): number {', '  return a + b;', '}', '', 'export class Calc {', '  total = add(1, 2);', '}', '', '// TODO: subtract', 'const x = add(3, 4);', ''].join('\n'),
  );
  process.env.AUTOCODE_LSP_TYPESCRIPT = `"${process.execPath}" "${fake}"`;
});

afterAll(async () => {
  await shutdownLsp();
  if (savedOverride === undefined) delete process.env.AUTOCODE_LSP_TYPESCRIPT;
  else process.env.AUTOCODE_LSP_TYPESCRIPT = savedOverride;
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    /* windows */
  }
});

describe('lsp tool against a scripted server', () => {
  it('parses overrides and discovers the override before anything else', () => {
    expect(parseCommandLine('"C:\\Program Files\\node.exe" server.js --stdio')).toEqual({ command: 'C:\\Program Files\\node.exe', args: ['server.js', '--stdio'] });
    const spec = discoverServer('typescript', root);
    expect(spec?.command).toBe(process.execPath);
    expect(spec?.args).toEqual([fake]);
  });

  it('locates positions from line/column or symbol', () => {
    const text = 'const a = 1;\nfunction add() {}\n';
    expect(locate(text, { line: 2, symbol: 'add' })).toEqual({ line: 1, character: 9 });
    expect(locate(text, { symbol: 'add' })).toEqual({ line: 1, character: 9 });
    expect(locate(text, { line: 1, column: 7 })).toEqual({ line: 0, character: 6 });
    expect(locate(text, { line: 9 })).toHaveProperty('error');
    expect(locate(text, { symbol: 'nope' })).toHaveProperty('error');
  });

  it('answers definition, references, hover, symbols and diagnostics', async () => {
    const tool = new LspTool();
    const def = await tool.execute({ operation: 'definition', path: 'src/math.ts', line: 6, symbol: 'add' }, { session: session() });
    expect(def.isError).toBeFalsy();
    expect(def.content).toMatch(/^src\/math\.ts:1:17  export function add/);

    const refs = await tool.execute({ operation: 'references', path: 'src/math.ts', symbol: 'add' }, { session: session() });
    expect(refs.summary).toMatch(/^3 references/);
    expect(refs.content.split('\n')).toHaveLength(3);

    const hover = await tool.execute({ operation: 'hover', path: 'src/math.ts', line: 10, symbol: 'add' }, { session: session() });
    expect(hover.content).toContain('function add(): number');

    const symbols = await tool.execute({ operation: 'symbols', path: 'src/math.ts' }, { session: session() });
    expect(symbols.content).toContain('function add  :1');
    expect(symbols.content).toContain('class Calc  :5');

    const diags = await tool.execute({ operation: 'diagnostics', path: 'src/math.ts' }, { session: session() });
    expect(diags.summary).toBe('1 diagnostic in src/math.ts (0 errors)');
    expect(diags.content).toContain('src/math.ts:9:1  [warning] Unresolved TODO (fake)');
  }, 30_000);

  it('reports a missing server with an install hint', async () => {
    const saved = process.env.AUTOCODE_LSP_PYTHON;
    delete process.env.AUTOCODE_LSP_PYTHON;
    const pathSaved = process.env.PATH;
    process.env.PATH = '';
    try {
      writeFileSync(join(root, 'a.py'), 'x = 1\n');
      const r = await new LspTool().execute({ operation: 'symbols', path: 'a.py' }, { session: session() });
      expect(r.isError).toBe(true);
      expect(r.content).toMatch(/no python language server found — pip install pyright/);
    } finally {
      process.env.PATH = pathSaved;
      if (saved !== undefined) process.env.AUTOCODE_LSP_PYTHON = saved;
    }
  });
});
