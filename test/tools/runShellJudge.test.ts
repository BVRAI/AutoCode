// run_shell's reviewer tier: a `confirm`-class command runs without a prompt
// when the judge clears it, and falls back to the user's confirm otherwise.

import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RunShellTool } from '../../src/tools/runShell.js';
import { classifyCommand } from '../../src/safety/SafetyPolicy.js';
import type { SessionContext } from '../../src/session/SessionContext.js';

// A command the classifier flags for confirmation and that fails harmlessly
// in an empty directory (no repository, no remote).
const RISKY = ['git push origin main', 'git push --force origin main', 'git reset --hard HEAD~1'].find(
  (c) => classifyCommand(c).kind === 'confirm',
);

function session(root: string): SessionContext {
  return {
    sessionId: 's',
    projectRoot: root,
    dataDir: join(root, 'data'),
    sessionDir: join(root, 'session'),
    model: { provider: 'xai', model: 'grok-code-fast-1' },
    startedAt: new Date().toISOString(),
    mode: 'autocode',
  };
}

describe('run_shell judge tier', () => {
  it('has a confirm-class command to test with', () => {
    expect(RISKY).toBeDefined();
  });

  it('runs the command without confirm when the judge allows it', async () => {
    const root = mkdtempSync(join(tmpdir(), 'autocode-judge-'));
    try {
      const calls: Array<{ command: string; reason: string }> = [];
      const r = await new RunShellTool().execute(
        { command: RISKY!, timeout_seconds: 30 },
        {
          session: session(root),
          confirm: async () => {
            throw new Error('confirm must not be called');
          },
          judge: async (input) => {
            calls.push(input);
            return { decision: 'allow', reason: 'a normal git operation for this request' };
          },
        },
      );
      expect(calls).toHaveLength(1);
      expect(calls[0]!.command).toBe(RISKY);
      expect(calls[0]!.reason.length).toBeGreaterThan(0);
      expect(r.metadata?.['judged']).toBe(true);
      expect(r.content).toContain('[auto mode] risky command allowed without asking');
      // It actually ran (and failed, as there is no repository here).
      expect(typeof r.metadata?.['exitCode']).toBe('number');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('falls through to confirm when the judge says ask, and to "confirm required" without a prompt', async () => {
    const root = mkdtempSync(join(tmpdir(), 'autocode-judge-'));
    try {
      let asked = 0;
      const declined = await new RunShellTool().execute(
        { command: RISKY! },
        {
          session: session(root),
          confirm: async () => {
            asked += 1;
            return false;
          },
          judge: async () => ({ decision: 'ask', reason: 'rewrites shared history' }),
        },
      );
      expect(asked).toBe(1);
      expect(declined.isError).toBe(true);
      expect(declined.summary).toBe('user declined');

      const headless = await new RunShellTool().execute(
        { command: RISKY! },
        { session: session(root), judge: async () => ({ decision: 'ask', reason: 'unsure' }) },
      );
      expect(headless.isError).toBe(true);
      expect(headless.summary).toMatch(/confirm required/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('treats a failing judge as ask', async () => {
    const root = mkdtempSync(join(tmpdir(), 'autocode-judge-'));
    try {
      let asked = 0;
      const r = await new RunShellTool().execute(
        { command: RISKY! },
        {
          session: session(root),
          confirm: async () => {
            asked += 1;
            return false;
          },
          judge: async () => {
            throw new Error('model down');
          },
        },
      );
      expect(asked).toBe(1);
      expect(r.summary).toBe('user declined');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
