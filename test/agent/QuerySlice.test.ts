import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodeIndex } from '../../src/index/CodeIndex.js';
import { buildQuerySlice } from '../../src/agent/QuerySlice.js';

let root: string;
let dataDir: string;
let index: CodeIndex;

function write(rel: string, text: string): void {
  const abs = join(root, rel);
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, text);
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'autocode-slice-'));
  dataDir = mkdtempSync(join(tmpdir(), 'autocode-slice-data-'));
  process.env.AUTOCODE_DATA_DIR = dataDir;
  write('src/tasks/Materializer.ts', "import { today } from '../time/clock.js';\nexport class Materializer {\n  materialize(): void { today(); }\n}\n");
  write('src/time/clock.ts', 'export function today(): Date { return new Date(); }\n');
  write('src/ui/Toolbar.tsx', 'export function Toolbar(): string { return ""; }\n');
  write('src/ui/Sidebar.tsx', 'export function Sidebar(): string { return ""; }\n');
  index = await CodeIndex.open(root);
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(dataDir, { recursive: true, force: true });
  delete process.env.AUTOCODE_DATA_DIR;
});

describe('buildQuerySlice', () => {
  it('seeds on identifiers and paths in the request and ranks their neighborhood first', () => {
    const slice = buildQuerySlice(index, 'where do tasks get materialized? the Materializer is slow');
    expect(slice).toContain('# Likely relevant to this request');
    const lines = slice.split('\n').slice(2);
    expect(lines[0]).toContain('src/tasks/Materializer.ts');
    expect(lines[0]).toContain('Materializer');
    expect(slice).toContain('src/time/clock.ts');
  });

  it('accepts an explicit path or file name', () => {
    const slice = buildQuerySlice(index, 'tweak Toolbar.tsx padding');
    expect(slice.split('\n')[2]).toContain('src/ui/Toolbar.tsx');
  });

  it('is empty when nothing in the request connects to the graph', () => {
    expect(buildQuerySlice(index, 'hello there, how are things going')).toBe('');
  });

  it('respects the byte budget', () => {
    const slice = buildQuerySlice(index, 'Materializer today Toolbar Sidebar', { maxBytes: 200 });
    expect(slice.length).toBeLessThanOrEqual(200);
  });
});
