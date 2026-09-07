import { describe, expect, it } from 'vitest';
import { judgePrompt, parseJudgement } from '../../src/agent/AutoApprover.js';
import { autoJudgeEnabled } from '../../src/agent/LiveAgent.js';

describe('AutoApprover (auto mode reviewer tier)', () => {
  it('builds a prompt that carries the command, the flag and the request, never tool output', () => {
    const p = judgePrompt({ command: 'git push origin main', reason: 'pushes to a remote', task: 'ship the fix', projectRoot: 'C:/proj' });
    expect(p.system).toMatch(/JSON only/);
    expect(p.user).toContain('Command:\ngit push origin main');
    expect(p.user).toContain('Flag: pushes to a remote');
    expect(p.user).toContain("User's request: ship the fix");
    expect(p.user).toContain('Project root: C:/proj');
  });

  it('caps the request and command it forwards', () => {
    const p = judgePrompt({ command: 'x'.repeat(5_000), reason: 'r', task: 'y'.repeat(5_000), projectRoot: '/p' });
    expect(p.user.length).toBeLessThan(4_000);
  });

  it('parses allow / ask and fails closed on garbage', () => {
    expect(parseJudgement('{"decision":"allow","reason":"runs the test suite"}')).toEqual({ decision: 'allow', reason: 'runs the test suite' });
    expect(parseJudgement('Sure: {"decision":"ask","reason":"touches ~/.ssh"} — done')).toEqual({ decision: 'ask', reason: 'touches ~/.ssh' });
    expect(parseJudgement('{"decision":"yes"}').decision).toBe('ask');
    expect(parseJudgement('allow').decision).toBe('ask');
    expect(parseJudgement('').reason).toMatch(/unparsable/);
  });

  it('is on by default, off by config, env or bench mode', () => {
    const env: NodeJS.ProcessEnv = {};
    expect(autoJudgeEnabled({}, env)).toBe(true);
    expect(autoJudgeEnabled({ autoMode: { reviewer: false } }, env)).toBe(false);
    expect(autoJudgeEnabled({ autoMode: { reviewer: false } }, { AUTOCODE_AUTO_JUDGE: 'on' })).toBe(true);
    expect(autoJudgeEnabled({}, { AUTOCODE_AUTO_JUDGE: 'off' })).toBe(false);
    const saved = process.env.AUTOCODE_BENCH_MODE;
    process.env.AUTOCODE_BENCH_MODE = '1';
    try {
      expect(autoJudgeEnabled({}, { AUTOCODE_AUTO_JUDGE: 'on' })).toBe(false);
    } finally {
      if (saved === undefined) delete process.env.AUTOCODE_BENCH_MODE;
      else process.env.AUTOCODE_BENCH_MODE = saved;
    }
  });
});
