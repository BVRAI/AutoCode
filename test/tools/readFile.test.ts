import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ReadFileTool } from '../../src/tools/readFile.js';
import type { ToolExecutionContext } from '../../src/tools/types.js';

let root: string;

function ctx(): ToolExecutionContext {
  return {
    session: {
      sessionId: 't',
      projectRoot: root,
      dataDir: root,
      sessionDir: root,
      model: { provider: 'xai', model: 'm' },
      startedAt: new Date().toISOString(),
      mode: 'autocode',
    },
  };
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'autocode-readfile-'));
  writeFileSync(join(root, 'ten.ts'), Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join('\n') + '\n');
  writeFileSync(join(root, 'wide.txt'), Array.from({ length: 5 }, () => 'x'.repeat(20_000)).join('\n'));
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('read_file line semantics', () => {
  it('reads the whole file by default and reports lines of total', async () => {
    const r = await new ReadFileTool().execute({ path: 'ten.ts' }, ctx());
    expect(r.summary).toBe('ten.ts: lines 1–10 of 10');
    expect(r.content.split('\n')).toHaveLength(10);
    expect(r.content).toContain('     1\tline 1');
    expect(r.content).toContain('    10\tline 10');
    expect(r.metadata).toMatchObject({ totalLines: 10, startLine: 1, endLine: 10, truncated: false });
  });

  it('offset is the first line (1-based) and limit counts lines', async () => {
    const r = await new ReadFileTool().execute({ path: 'ten.ts', offset: 4, limit: 3 }, ctx());
    expect(r.summary).toBe('ten.ts: lines 4–6 of 10 (truncated)');
    expect(r.content.split('\n').slice(0, 3)).toEqual(['     4\tline 4', '     5\tline 5', '     6\tline 6']);
    expect(r.content).toContain('… 4 more lines (read_file with offset=7)');
    // `length` from the old byte-based schema means lines now.
    const legacy = await new ReadFileTool().execute({ path: 'ten.ts', offset: 9, length: 5 }, ctx());
    expect(legacy.summary).toBe('ten.ts: lines 9–10 of 10');
  });

  it('rejects an offset past the end and caps oversized slices by bytes', async () => {
    const past = await new ReadFileTool().execute({ path: 'ten.ts', offset: 11 }, ctx());
    expect(past.isError).toBe(true);
    expect(past.summary).toContain('past the end');
    const wide = await new ReadFileTool().execute({ path: 'wide.txt' }, ctx());
    expect(wide.summary).toBe('wide.txt: lines 1–2 of 5 (truncated)');
    expect(wide.content).toContain('this slice hit the size cap');
  });
});
