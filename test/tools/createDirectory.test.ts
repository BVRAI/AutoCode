import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CreateDirectoryTool } from '../../src/tools/createDirectory.js';
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

describe('create_directory', () => {
  let root: string;
  let ctx: ToolExecutionContext;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'autocode-mkdir-'));
    ctx = makeCtx(root);
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('creates a new directory under the project root', async () => {
    const out = await new CreateDirectoryTool().execute({ path: 'test website' }, ctx);
    expect(out.isError).toBeFalsy();
    expect(out.summary).toMatch(/^created /);
    expect(existsSync(join(root, 'test website'))).toBe(true);
    expect(statSync(join(root, 'test website')).isDirectory()).toBe(true);
  });

  it('refuses when target exists and exist_ok is false (default)', async () => {
    mkdirSync(join(root, 'already'));
    const out = await new CreateDirectoryTool().execute({ path: 'already' }, ctx);
    expect(out.isError).toBe(true);
    expect(out.content).toMatch(/already exists/);
  });

  it('succeeds when target exists and exist_ok is true', async () => {
    mkdirSync(join(root, 'already'));
    const out = await new CreateDirectoryTool().execute(
      { path: 'already', exist_ok: true },
      ctx,
    );
    expect(out.isError).toBeFalsy();
    expect(out.summary).toMatch(/already existed/);
    expect(out.metadata?.preExisted).toBe(true);
  });

  it('creates intermediate parents (recursive mkdir)', async () => {
    const out = await new CreateDirectoryTool().execute({ path: 'a/b/c' }, ctx);
    expect(out.isError).toBeFalsy();
    expect(existsSync(join(root, 'a', 'b', 'c'))).toBe(true);
  });

  it('refuses a leading-slash path that resolves outside the project root', async () => {
    // This is the regression test for the actual bug: `\test website` on Windows
    // means the root of the current drive. resolveInsideRoot rejects it.
    const out = await new CreateDirectoryTool().execute({ path: '/test website' }, ctx);
    expect(out.isError).toBe(true);
    expect(out.content).toMatch(/escapes project root|relative/i);
    // And critically: nothing was created inside the project.
    expect(existsSync(join(root, 'test website'))).toBe(false);
  });

  it('refuses when path exists as a file (not a directory)', async () => {
    writeFileSync(join(root, 'thing'), 'i am a file');
    const out = await new CreateDirectoryTool().execute(
      { path: 'thing', exist_ok: true },
      ctx,
    );
    expect(out.isError).toBe(true);
    expect(out.content).toMatch(/file/i);
  });
});
