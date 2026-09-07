// A timed-out shell command must return promptly even when the program the
// shell started outlives the shell and keeps the output pipes open.

import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RunShellTool } from '../../src/tools/runShell.js';
import type { SessionContext } from '../../src/session/SessionContext.js';

function session(root: string): SessionContext {
  return { sessionId: 's', projectRoot: root, dataDir: join(root, 'data'), sessionDir: join(root, 'session'), model: { provider: 'xai', model: 'm' }, startedAt: new Date().toISOString(), mode: 'autocode' };
}

// A parent that spawns a grandchild sleeping 60 s with inherited stdio, then sleeps itself.
const HANG_WITH_GRANDCHILD =
  `node -e "const {spawn}=require('child_process');spawn(process.execPath,['-e','setTimeout(()=>{},60000)'],{stdio:'inherit'});console.log('started');setTimeout(()=>{},60000)"`;

describe('run_shell timeouts', () => {
  it('settles shortly after the timeout even if a grandchild holds the pipes', async () => {
    const root = mkdtempSync(join(tmpdir(), 'autocode-shell-timeout-'));
    try {
      const t0 = Date.now();
      const r = await new RunShellTool().execute({ command: HANG_WITH_GRANDCHILD, timeout_seconds: 2 }, { session: session(root) });
      const elapsed = Date.now() - t0;
      expect(r.isError).toBe(true);
      expect(r.summary).toMatch(/timed out/);
      expect(r.content).toContain('started');
      expect(r.content).toMatch(/process tree killed/);
      expect(elapsed).toBeLessThan(9_000);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 20_000);

  it('returns normally for a command that exits on its own', async () => {
    const root = mkdtempSync(join(tmpdir(), 'autocode-shell-timeout-'));
    try {
      const r = await new RunShellTool().execute({ command: 'node -e "console.log(\'quick\')"', timeout_seconds: 10 }, { session: session(root) });
      expect(r.isError).toBe(false);
      expect(r.content).toContain('quick');
      expect(r.metadata?.['timedOut']).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
