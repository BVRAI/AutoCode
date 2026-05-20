import { describe, it, expect } from 'vitest';
import { tmpdir } from 'node:os';
import { RunShellTool } from '../../src/tools/runShell.js';
import type { ToolExecutionContext } from '../../src/tools/types.js';
import type { SessionContext } from '../../src/session/SessionContext.js';

function ctx(): ToolExecutionContext {
  const session: SessionContext = {
    sessionId: 't',
    projectRoot: tmpdir(),
    dataDir: tmpdir(),
    sessionDir: tmpdir(),
    model: { provider: 'xai', model: 'm' },
    startedAt: new Date().toISOString(),
    mode: 'autocode',
  };
  return { session };
}

describe('run_shell background mode', () => {
  it('returns promptly for a long-running process instead of hanging', async () => {
    const t0 = Date.now();
    const out = await new RunShellTool().execute(
      { command: 'node -e "setInterval(()=>{},1000)"', background: true },
      ctx(),
    );
    const elapsed = Date.now() - t0;
    expect(out.metadata?.background).toBe(true);
    // returns after the ~3s grace window, not the 300s foreground timeout
    expect(elapsed).toBeLessThan(15_000);
    const pid = out.metadata?.pid as number | undefined;
    if (pid) {
      try {
        process.kill(pid);
      } catch {
        /* already gone */
      }
    }
  }, 20_000);

  it('captures startup output from a quick background command', async () => {
    const out = await new RunShellTool().execute(
      { command: 'echo hello-bg', background: true },
      ctx(),
    );
    expect(out.content).toContain('hello-bg');
  }, 20_000);
});
