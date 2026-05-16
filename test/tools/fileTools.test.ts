import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ListDirectoryTool } from '../../src/tools/listDirectory.js';
import { ReadFileTool } from '../../src/tools/readFile.js';
import { EditFileTool } from '../../src/tools/editFile.js';
import { WriteFileTool } from '../../src/tools/writeFile.js';
import { GlobTool } from '../../src/tools/glob.js';
import { GrepTool } from '../../src/tools/grep.js';
import type { ToolExecutionContext } from '../../src/tools/types.js';
import type { SessionContext } from '../../src/session/SessionContext.js';

function makeCtx(root: string): ToolExecutionContext {
  const session: SessionContext = {
    sessionId: 'test',
    projectRoot: root,
    dataDir: root,
    sessionDir: join(root, 'session'),
    model: { provider: 'anthropic', model: 'claude-opus-4-7' },
    startedAt: new Date().toISOString(),
  };
  return { session };
}

describe('file tools', () => {
  let root: string;
  let ctx: ToolExecutionContext;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'autocode-tools-'));
    ctx = makeCtx(root);
    writeFileSync(join(root, 'a.txt'), 'alpha\nbeta\ngamma\n');
    writeFileSync(join(root, 'b.md'), '# heading\n\ncontent here\n');
    mkdirSync(join(root, 'sub'));
    writeFileSync(join(root, 'sub', 'c.ts'), 'export const x = 1;\n');
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('list_directory lists files non-recursively', async () => {
    const out = await new ListDirectoryTool().execute({ path: '.' }, ctx);
    expect(out.content).toContain('a.txt');
    expect(out.content).toContain('b.md');
    expect(out.content).toContain('sub/');
    // Non-recursive: should NOT include sub/c.ts
    expect(out.content).not.toContain('sub/c.ts');
  });

  it('list_directory recurses when asked', async () => {
    const out = await new ListDirectoryTool().execute({ path: '.', recursive: true }, ctx);
    expect(out.content).toContain('sub/c.ts');
  });

  it('read_file returns numbered lines', async () => {
    const out = await new ReadFileTool().execute({ path: 'a.txt' }, ctx);
    expect(out.content).toMatch(/1\talpha/);
    expect(out.content).toMatch(/2\tbeta/);
  });

  it('read_file refuses paths outside project root', async () => {
    await expect(
      new ReadFileTool().execute({ path: '../escape.txt' }, ctx),
    ).rejects.toThrow(/escapes project root/);
  });

  it('edit_file rejects when old_text not found', async () => {
    const out = await new EditFileTool().execute(
      { path: 'a.txt', old_text: 'nope', new_text: 'x' },
      ctx,
    );
    expect(out.isError).toBe(true);
    expect(out.summary).toMatch(/not found/);
  });

  it('edit_file rejects ambiguous match', async () => {
    writeFileSync(join(root, 'dup.txt'), 'foo\nfoo\nfoo\n');
    const out = await new EditFileTool().execute(
      { path: 'dup.txt', old_text: 'foo', new_text: 'bar' },
      ctx,
    );
    expect(out.isError).toBe(true);
    expect(out.summary).toMatch(/ambiguous/);
  });

  it('edit_file applies a unique match', async () => {
    const out = await new EditFileTool().execute(
      { path: 'a.txt', old_text: 'beta', new_text: 'BETA' },
      ctx,
    );
    expect(out.isError).toBeFalsy();
    expect(readFileSync(join(root, 'a.txt'), 'utf8')).toBe('alpha\nBETA\ngamma\n');
  });

  it('edit_file replace_all rewrites all occurrences', async () => {
    writeFileSync(join(root, 'dup.txt'), 'foo\nfoo\nfoo\n');
    const out = await new EditFileTool().execute(
      { path: 'dup.txt', old_text: 'foo', new_text: 'bar', replace_all: true },
      ctx,
    );
    expect(out.isError).toBeFalsy();
    expect(readFileSync(join(root, 'dup.txt'), 'utf8')).toBe('bar\nbar\nbar\n');
  });

  it('write_file create_only refuses to clobber', async () => {
    const out = await new WriteFileTool().execute(
      { path: 'a.txt', content: 'new' },
      ctx,
    );
    expect(out.isError).toBe(true);
  });

  it('write_file overwrite replaces existing', async () => {
    const out = await new WriteFileTool().execute(
      { path: 'a.txt', content: 'new', mode: 'overwrite' },
      ctx,
    );
    expect(out.isError).toBeFalsy();
    expect(readFileSync(join(root, 'a.txt'), 'utf8')).toBe('new');
  });

  it('write_file creates nested directories', async () => {
    const out = await new WriteFileTool().execute(
      { path: 'deep/nested/new.txt', content: 'x' },
      ctx,
    );
    expect(out.isError).toBeFalsy();
    expect(readFileSync(join(root, 'deep', 'nested', 'new.txt'), 'utf8')).toBe('x');
  });

  it('glob matches files by pattern', async () => {
    const out = await new GlobTool().execute({ pattern: '**/*.ts' }, ctx);
    expect(out.content).toMatch(/sub\/c\.ts/);
  });

  it('grep finds matching lines with line numbers', async () => {
    const out = await new GrepTool().execute({ pattern: 'beta' }, ctx);
    expect(out.content).toMatch(/a\.txt:2:.*beta/);
  });

  it('grep with glob filter only scans matching files', async () => {
    const out = await new GrepTool().execute(
      { pattern: 'export', glob: '**/*.ts' },
      ctx,
    );
    expect(out.content).toMatch(/c\.ts:1:.*export/);
  });
});
