import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FindSymbolTool } from '../../src/tools/findSymbol.js';
import type { ToolExecutionContext } from '../../src/tools/types.js';
import type { SessionContext } from '../../src/session/SessionContext.js';

function ctxFor(projectRoot: string): ToolExecutionContext {
  const session: SessionContext = {
    sessionId: 'fs-test',
    projectRoot,
    dataDir: tmpdir(),
    sessionDir: tmpdir(),
    model: { provider: 'xai', model: 'm' },
    startedAt: new Date().toISOString(),
    mode: 'autocode',
  };
  return { session };
}

describe('FindSymbolTool', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'autocode-findsym-'));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('finds a TypeScript function declaration AND its call sites with kind=any', async () => {
    writeFileSync(
      join(root, 'a.ts'),
      `export function foo(): number {\n  return 1;\n}\n`,
    );
    writeFileSync(
      join(root, 'b.ts'),
      `import { foo } from './a';\nconst x = foo();\n`,
    );
    const r = await new FindSymbolTool().execute({ name: 'foo' }, ctxFor(root));
    expect(r.isError).toBeFalsy();
    const hits = (r.metadata!.hits as Array<{ file: string; kind: string }>).map((h) => `${h.file}:${h.kind}`);
    expect(hits).toContain('a.ts:definition');
    expect(hits).toContain('b.ts:reference');
    expect(hits.some((h) => h.startsWith('b.ts:reference'))).toBe(true);
  });

  it('kind=definition returns only the declaration site', async () => {
    writeFileSync(join(root, 'a.ts'), `export function foo() {}\n`);
    writeFileSync(join(root, 'b.ts'), `foo();\nfoo();\n`);
    const r = await new FindSymbolTool().execute({ name: 'foo', kind: 'definition' }, ctxFor(root));
    const hits = r.metadata!.hits as Array<{ file: string; kind: string }>;
    expect(hits).toHaveLength(1);
    expect(hits[0]!.file).toBe('a.ts');
    expect(hits[0]!.kind).toBe('definition');
  });

  it('kind=reference includes the declaration line too (intentional)', async () => {
    writeFileSync(join(root, 'a.ts'), `export function foo() {}\n`);
    writeFileSync(join(root, 'b.ts'), `foo();\n`);
    const r = await new FindSymbolTool().execute({ name: 'foo', kind: 'reference' }, ctxFor(root));
    const hits = r.metadata!.hits as Array<{ file: string }>;
    expect(hits.map((h) => h.file).sort()).toEqual(['a.ts', 'b.ts']);
  });

  it('finds a Python definition with `def`', async () => {
    writeFileSync(join(root, 'm.py'), `def add(a, b):\n    return a + b\n`);
    const r = await new FindSymbolTool().execute({ name: 'add', kind: 'definition' }, ctxFor(root));
    const hits = r.metadata!.hits as Array<{ file: string; kind: string }>;
    expect(hits).toHaveLength(1);
    expect(hits[0]!.file).toBe('m.py');
  });

  it('finds across multiple languages by default', async () => {
    writeFileSync(join(root, 'a.ts'), `export function bar() {}\n`);
    writeFileSync(join(root, 'b.py'), `def bar():\n    pass\n`);
    const r = await new FindSymbolTool().execute({ name: 'bar', kind: 'definition' }, ctxFor(root));
    const files = (r.metadata!.hits as Array<{ file: string }>).map((h) => h.file).sort();
    expect(files).toEqual(['a.ts', 'b.py']);
  });

  it('language filter restricts to one extension family', async () => {
    writeFileSync(join(root, 'a.ts'), `export function bar() {}\n`);
    writeFileSync(join(root, 'b.py'), `def bar():\n    pass\n`);
    const r = await new FindSymbolTool().execute(
      { name: 'bar', kind: 'definition', language: 'python' },
      ctxFor(root),
    );
    const files = (r.metadata!.hits as Array<{ file: string }>).map((h) => h.file);
    expect(files).toEqual(['b.py']);
  });

  it('returns empty result (not an error) when nothing matches', async () => {
    writeFileSync(join(root, 'a.ts'), `export function foo() {}\n`);
    const r = await new FindSymbolTool().execute({ name: 'doesnotexist' }, ctxFor(root));
    expect(r.isError).toBeFalsy();
    expect((r.metadata!.hits as unknown[]).length).toBe(0);
    expect(r.content).toContain('no matches');
  });

  it('rejects an unknown language with a friendly error', async () => {
    writeFileSync(join(root, 'a.ts'), `export function foo() {}\n`);
    const r = await new FindSymbolTool().execute(
      { name: 'foo', language: 'cobol' },
      ctxFor(root),
    );
    expect(r.isError).toBe(true);
    expect(r.content).toContain('language must be one of');
  });

  it('skips files under NOISE_DIRS like node_modules', async () => {
    mkdirSync(join(root, 'node_modules', 'pkg'), { recursive: true });
    writeFileSync(join(root, 'node_modules', 'pkg', 'index.ts'), `export function foo() {}\n`);
    writeFileSync(join(root, 'real.ts'), `export function foo() {}\n`);
    const r = await new FindSymbolTool().execute({ name: 'foo', kind: 'definition' }, ctxFor(root));
    const files = (r.metadata!.hits as Array<{ file: string }>).map((h) => h.file);
    expect(files).toEqual(['real.ts']);
  });

  it('escapes regex-special characters in the searched name', async () => {
    writeFileSync(join(root, 'a.ts'), `const x = arr.find();\n`);
    const r = await new FindSymbolTool().execute({ name: 'find', kind: 'reference' }, ctxFor(root));
    expect(r.isError).toBeFalsy();
    expect((r.metadata!.hits as unknown[]).length).toBeGreaterThanOrEqual(1);
  });
});
