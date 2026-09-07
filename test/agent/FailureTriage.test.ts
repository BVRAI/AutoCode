import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodeIndex } from '../../src/index/CodeIndex.js';
import { extractFailingPaths, triageFailures } from '../../src/agent/FailureTriage.js';

let root: string;
let dataDir: string;
let index: CodeIndex;

function write(rel: string, text: string): void {
  const abs = join(root, rel);
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, text);
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'autocode-triage-'));
  dataDir = mkdtempSync(join(tmpdir(), 'autocode-triage-data-'));
  process.env.AUTOCODE_DATA_DIR = dataDir;
  write('src/money.ts', 'export function add(a: number, b: number): number { return a + b; }\n');
  write('src/money.test.ts', "import { add } from './money.js';\nadd(1, 2);\n");
  write('src/report.ts', "import { add } from './money.js';\nexport function report(): number { return add(1, 1); }\n");
  write('src/report.test.ts', "import { report } from './report.js';\nreport();\n");
  write('src/unrelated.test.ts', 'export const x = 1;\n');
  index = await CodeIndex.open(root);
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(dataDir, { recursive: true, force: true });
  delete process.env.AUTOCODE_DATA_DIR;
});

describe('extractFailingPaths', () => {
  it('finds project files in vitest, pytest, tsc and absolute-path shapes, existing ones only', () => {
    const out = [
      ' FAIL  src/money.test.ts > add',
      `    at ${join(root, 'src', 'report.ts').replace(/\\/g, '/')}:2:41`,
      'src\\unrelated.test.ts(1,14): error TS2322: nope',
      'FAILED tests/test_missing.py::test_x',
      'node_modules/vitest/dist/index.js:1:1',
    ].join('\n');
    expect(extractFailingPaths(out, root)).toEqual(['src/money.test.ts', 'src/report.ts', 'src/unrelated.test.ts']);
  });
});

describe('triageFailures', () => {
  it('relates changed files, their test twins, and importers through the graph', () => {
    const t = triageFailures(index, ['src/money.ts'], ['src/money.test.ts', 'src/report.test.ts', 'src/unrelated.test.ts']);
    expect(t.decidable).toBe(true);
    expect(t.related).toEqual(['src/money.test.ts', 'src/report.test.ts']);
    expect(t.unrelated).toEqual(['src/unrelated.test.ts']);
  });

  it('is conservative without an index', () => {
    const t = triageFailures(undefined, ['src/money.ts'], ['src/unrelated.test.ts']);
    expect(t.decidable).toBe(false);
    expect(t.related).toEqual(['src/unrelated.test.ts']);
  });
});
