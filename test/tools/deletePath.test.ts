import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DeletePathTool } from '../../src/tools/deletePath.js';
import { CheckpointStore } from '../../src/session/CheckpointStore.js';
import type { ToolExecutionContext } from '../../src/tools/types.js';
import type { SessionContext, AgentMode } from '../../src/session/SessionContext.js';

describe('delete_path', () => {
  let dataRoot: string;
  let proj: string;
  let cp: CheckpointStore;

  beforeEach(() => {
    dataRoot = mkdtempSync(join(tmpdir(), 'autocode-del-'));
    vi.stubEnv('AUTOCODE_DATA_DIR', dataRoot);
    proj = join(dataRoot, 'proj');
    mkdirSync(proj, { recursive: true });
    mkdirSync(join(dataRoot, 's'), { recursive: true });
    cp = new CheckpointStore(join(dataRoot, 's'));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(dataRoot, { recursive: true, force: true });
  });

  function ctx(mode: AgentMode = 'autocode', confirm?: (p: string) => Promise<boolean>): ToolExecutionContext {
    const session: SessionContext = {
      sessionId: 't',
      projectRoot: proj,
      dataDir: dataRoot,
      sessionDir: join(dataRoot, 's'),
      model: { provider: 'xai', model: 'm' },
      startedAt: new Date().toISOString(),
      mode,
    };
    return { session, confirm, checkpoint: cp };
  }

  it('moves a single file to the trash', async () => {
    writeFileSync(join(proj, 'x.txt'), 'data');
    const out = await new DeletePathTool().execute({ path: 'x.txt' }, ctx());
    expect(out.isError).toBeFalsy();
    expect(existsSync(join(proj, 'x.txt'))).toBe(false);
    expect(cp.listTrash().length).toBe(1);
  });

  it('refuses a path that escapes the project root', async () => {
    const out = await new DeletePathTool().execute({ path: '../escape' }, ctx());
    expect(out.isError).toBe(true);
    expect(out.content).toMatch(/refused/i);
  });

  it('errors when no checkpoint store is attached', async () => {
    writeFileSync(join(proj, 'y.txt'), 'data');
    const c = ctx();
    c.checkpoint = undefined;
    const out = await new DeletePathTool().execute({ path: 'y.txt' }, c);
    expect(out.isError).toBe(true);
  });

  it('asks for confirmation before deleting a large directory in autocode mode', async () => {
    const big = join(proj, 'big');
    mkdirSync(join(big, 'sub'), { recursive: true });
    for (let i = 0; i < 3; i++) writeFileSync(join(big, `f${i}.txt`), 'x');
    let asked = false;
    const confirm = async (): Promise<boolean> => {
      asked = true;
      return false; // decline
    };
    const out = await new DeletePathTool().execute({ path: 'big' }, ctx('autocode', confirm));
    expect(asked).toBe(true);
    expect(out.isError).toBe(true);
    expect(existsSync(big)).toBe(true); // declined → still there
  });
});
