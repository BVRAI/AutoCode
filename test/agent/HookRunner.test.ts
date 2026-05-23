import { describe, it, expect } from 'vitest';
import { tmpdir } from 'node:os';
import {
  blockingReason,
  hookMatches,
  runHooksForEvent,
  type HookContext,
} from '../../src/agent/HookRunner.js';

function ctx(overrides: Partial<HookContext> = {}): HookContext {
  return {
    event: 'pre_tool',
    projectRoot: tmpdir(),
    sessionId: 'test-session',
    ...overrides,
  };
}

describe('hookMatches', () => {
  it('matches all tools when match is absent or "*"', () => {
    expect(hookMatches({ command: 'x' }, 'edit_file')).toBe(true);
    expect(hookMatches({ command: 'x', match: '*' }, 'edit_file')).toBe(true);
    expect(hookMatches({ command: 'x', match: '*' }, 'write_file')).toBe(true);
  });

  it('matches a single exact tool name', () => {
    expect(hookMatches({ command: 'x', match: 'edit_file' }, 'edit_file')).toBe(true);
    expect(hookMatches({ command: 'x', match: 'edit_file' }, 'write_file')).toBe(false);
  });

  it('matches any of `|`-separated names', () => {
    const s = { command: 'x', match: 'edit_file|write_file' };
    expect(hookMatches(s, 'edit_file')).toBe(true);
    expect(hookMatches(s, 'write_file')).toBe(true);
    expect(hookMatches(s, 'read_file')).toBe(false);
  });

  it('does not match when toolName is undefined and match is specific', () => {
    expect(hookMatches({ command: 'x', match: 'edit_file' }, undefined)).toBe(false);
  });

  it('does match when toolName is undefined but match is "*" or absent', () => {
    expect(hookMatches({ command: 'x' }, undefined)).toBe(true);
    expect(hookMatches({ command: 'x', match: '*' }, undefined)).toBe(true);
  });
});

describe('runHooksForEvent', () => {
  it('returns [] when no hooks are configured', async () => {
    const r = await runHooksForEvent(undefined, ctx());
    expect(r).toEqual([]);
  });

  it('returns [] when no hooks match the tool', async () => {
    const r = await runHooksForEvent(
      [{ match: 'edit_file', command: 'node -e "process.exit(0)"' }],
      ctx({ toolName: 'read_file' }),
    );
    expect(r).toEqual([]);
  });

  it('runs a matching hook and captures stdout', async () => {
    const r = await runHooksForEvent(
      [{ command: 'node -e "console.log(\'hi\'); process.exit(0)"' }],
      ctx({ toolName: 'edit_file' }),
    );
    expect(r).toHaveLength(1);
    expect(r[0]!.exitCode).toBe(0);
    expect(r[0]!.stdout.trim()).toBe('hi');
    expect(r[0]!.blocked).toBe(false);
  });

  it('marks a pre_tool exit-2 as blocked and captures stderr', async () => {
    const r = await runHooksForEvent(
      [{ command: 'node -e "process.stderr.write(\'nope\'); process.exit(2)"' }],
      ctx({ event: 'pre_tool', toolName: 'edit_file' }),
    );
    expect(r).toHaveLength(1);
    expect(r[0]!.exitCode).toBe(2);
    expect(r[0]!.blocked).toBe(true);
    expect(r[0]!.stderr).toContain('nope');
  });

  it('does NOT mark exit-2 as blocked when event is post_tool', async () => {
    const r = await runHooksForEvent(
      [{ command: 'node -e "process.exit(2)"' }],
      ctx({ event: 'post_tool', toolName: 'edit_file' }),
    );
    expect(r[0]!.exitCode).toBe(2);
    expect(r[0]!.blocked).toBe(false);
  });

  it('does NOT mark non-zero (non-2) as blocked', async () => {
    const r = await runHooksForEvent(
      [{ command: 'node -e "process.exit(1)"' }],
      ctx({ event: 'pre_tool', toolName: 'edit_file' }),
    );
    expect(r[0]!.exitCode).toBe(1);
    expect(r[0]!.blocked).toBe(false);
  });

  it('passes context to the hook via env vars', async () => {
    const r = await runHooksForEvent(
      [
        {
          command:
            'node -e "console.log(process.env.AUTOCODE_HOOK_EVENT + \'|\' + process.env.AUTOCODE_HOOK_TOOL_NAME + \'|\' + process.env.AUTOCODE_HOOK_TOOL_ARGS_JSON)"',
        },
      ],
      ctx({ event: 'pre_tool', toolName: 'edit_file', toolArgs: { path: 'foo.ts' } }),
    );
    const out = r[0]!.stdout.trim();
    expect(out).toContain('pre_tool|edit_file|');
    expect(out).toContain('"path":"foo.ts"');
  });

  it('kills a hook that exceeds its timeout', async () => {
    const r = await runHooksForEvent(
      [{ command: 'node -e "setInterval(()=>{}, 1000)"', timeoutMs: 500 }],
      ctx({ toolName: 'edit_file' }),
    );
    expect(r).toHaveLength(1);
    expect(r[0]!.timedOut).toBe(true);
  }, 10_000);

  it('runs serially in declared order', async () => {
    const r = await runHooksForEvent(
      [
        { command: 'node -e "console.log(\'A\')"' },
        { command: 'node -e "console.log(\'B\')"' },
        { command: 'node -e "console.log(\'C\')"' },
      ],
      ctx({ toolName: 'edit_file' }),
    );
    expect(r.map((o) => o.stdout.trim())).toEqual(['A', 'B', 'C']);
  });

  it('does not require a toolName for stop-event hooks', async () => {
    const r = await runHooksForEvent(
      [{ command: 'node -e "console.log(\'bye\')"' }],
      ctx({ event: 'stop', toolName: undefined }),
    );
    expect(r).toHaveLength(1);
    expect(r[0]!.stdout.trim()).toBe('bye');
  });
});

describe('blockingReason', () => {
  it('returns null when nothing blocked', () => {
    expect(
      blockingReason([
        {
          event: 'pre_tool',
          command: 'x',
          exitCode: 0,
          stdout: '',
          stderr: '',
          timedOut: false,
          blocked: false,
          durationMs: 1,
        },
      ]),
    ).toBeNull();
  });

  it('concatenates stderr from blocking hooks into a single reason', () => {
    const reason = blockingReason([
      {
        event: 'pre_tool',
        command: 'h1',
        exitCode: 0,
        stdout: '',
        stderr: '',
        timedOut: false,
        blocked: false,
        durationMs: 1,
      },
      {
        event: 'pre_tool',
        command: 'h2',
        exitCode: 2,
        stdout: '',
        stderr: 'no edits to vendor/',
        timedOut: false,
        blocked: true,
        durationMs: 1,
      },
    ]);
    expect(reason).toContain('h2');
    expect(reason).toContain('no edits to vendor/');
  });
});
