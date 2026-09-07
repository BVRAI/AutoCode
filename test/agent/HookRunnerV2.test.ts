import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  applyStdoutJson,
  blockingReason,
  matcherMatches,
  normalizeHooks,
  permissionDecision,
  runHooks,
  type HookOutcome,
} from '../../src/agent/HookRunner.js';
import { HookHub, readProjectHooks } from '../../src/agent/HookHub.js';

const NODE = process.execPath.includes(' ') ? `"${process.execPath}"` : process.execPath;

function outcome(partial: Partial<HookOutcome>): HookOutcome {
  return { event: 'PreToolUse', command: 'x', exitCode: 0, stdout: '', stderr: '', timedOut: false, durationMs: 0, blocked: false, ...partial };
}

describe('normalizeHooks', () => {
  it('maps the legacy flat shape onto events with anchored matchers', () => {
    const m = normalizeHooks({ pre_tool: [{ match: 'run_shell|edit_file', command: 'a' }], post_tool: [{ command: 'b' }], stop: [{ command: 'c' }] });
    expect([...m.keys()]).toEqual(['PreToolUse', 'PostToolUse', 'SessionEnd']);
    expect(m.get('PreToolUse')![0]!.matcher).toBe('^(?:run_shell|edit_file)$');
    expect(m.get('PostToolUse')![0]!.matcher).toBeUndefined();
  });

  it("accepts Claude Code's event shape and skips malformed groups", () => {
    const m = normalizeHooks({
      PreToolUse: [{ matcher: 'Bash(git *)', hooks: [{ type: 'command', command: 'check-git', timeout: 5 }] }, { hooks: [] }, 'junk' as never],
      Stop: [{ command: 'notify' } as never],
    });
    expect(m.get('PreToolUse')).toHaveLength(1);
    expect(m.get('PreToolUse')![0]!.hooks[0]!.timeout).toBe(5);
    expect(m.get('Stop')![0]!.hooks[0]!.command).toBe('notify');
  });
});

describe('matcherMatches', () => {
  it('matches everything on empty or *', () => {
    expect(matcherMatches(undefined, 'run_shell')).toBe(true);
    expect(matcherMatches('*', 'edit_file')).toBe(true);
  });

  it('understands Tool(prefix *) forms with Claude Code aliases', () => {
    expect(matcherMatches('Bash(git *)', 'run_shell', { command: 'git status' })).toBe(true);
    expect(matcherMatches('Bash(git *)', 'run_shell', { command: 'npm test' })).toBe(false);
    expect(matcherMatches('Edit(src/*)', 'edit_file', { path: 'src\\a.ts' })).toBe(true);
    expect(matcherMatches('Edit(src/*)', 'write_file', { path: 'src/a.ts' })).toBe(false);
    expect(matcherMatches('Bash(npm test)', 'run_shell', { command: 'npm test' })).toBe(true);
  });

  it('treats plain names as anchored regexes over either naming', () => {
    expect(matcherMatches('Edit|Write', 'edit_file')).toBe(true);
    expect(matcherMatches('Edit|Write', 'read_file')).toBe(false);
    expect(matcherMatches('mcp__.*', 'mcp__srv__tool')).toBe(true);
    expect(matcherMatches('^edit', 'edit_file')).toBe(false);
  });
});

describe('stdout contract', () => {
  it('reads permission decisions, updated input and context', () => {
    const o = outcome({});
    applyStdoutJson(o, JSON.stringify({ hookSpecificOutput: { permissionDecision: 'deny', permissionDecisionReason: 'no', updatedInput: { command: 'ls' }, additionalContext: 'ctx' }, systemMessage: 'hi' }), true);
    expect(o.decision).toBe('deny');
    expect(o.blocked).toBe(true);
    expect(o.reason).toBe('no');
    expect(o.updatedInput).toEqual({ command: 'ls' });
    expect(o.additionalContext).toBe('ctx');
    expect(o.systemMessage).toBe('hi');
    expect(blockingReason([o])).toContain('no');
    expect(permissionDecision([outcome({ decision: 'allow' }), outcome({ decision: 'ask' })]).decision).toBe('ask');
  });

  it('ignores plain-text stdout and honors continue:false', () => {
    const o = outcome({});
    applyStdoutJson(o, 'all good', false);
    expect(o.decision).toBeUndefined();
    applyStdoutJson(o, '{"continue": false, "stopReason": "enough"}', false);
    expect(o.halt).toBe(true);
    expect(o.stopReason).toBe('enough');
  });
});

describe('runHooks', () => {
  it('feeds JSON on stdin, blocks on exit 2 with stderr, and parses stdout JSON', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'autocode-hooks-'));
    const echo = join(dir, 'echo.js');
    writeFileSync(echo, "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const i=JSON.parse(d);process.stdout.write(JSON.stringify({hookSpecificOutput:{additionalContext:'tool='+i.tool_name+' event='+i.hook_event_name}}));});");
    const deny = join(dir, 'deny.js');
    writeFileSync(deny, "process.stderr.write('not here');process.exit(2)");
    const outcomes = await runHooks(
      'PreToolUse',
      [
        { matcher: 'run_shell', hooks: [{ command: `${NODE} "${echo}"` }, { command: `${NODE} "${deny}"` }] },
        { matcher: 'edit_file', hooks: [{ command: `${NODE} -e "process.exit(3)"` }] },
      ],
      { session_id: 's', cwd: dir, tool_name: 'run_shell', tool_input: { command: 'rm -rf x' } },
    );
    expect(outcomes).toHaveLength(2);
    expect(outcomes[0]!.additionalContext).toBe('tool=run_shell event=PreToolUse');
    expect(outcomes[1]!.blocked).toBe(true);
    expect(blockingReason(outcomes)).toContain('not here');
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('HookHub', () => {
  it('merges config, project hooks.json and .claude/settings.json hooks', async () => {
    const root = mkdtempSync(join(tmpdir(), 'autocode-hub-'));
    mkdirSync(join(root, '.autocode'), { recursive: true });
    writeFileSync(join(root, '.autocode', 'hooks.json'), JSON.stringify({ hooks: { Stop: [{ hooks: [{ command: 'echo stop' }] }] } }));
    expect([...readProjectHooks(root).keys()]).toEqual(['Stop']);
    const hub = new HookHub(root, 'sess', { config: { PreToolUse: [{ matcher: 'Bash(git *)', hooks: [{ command: 'x' }] }] }, includePlugins: false });
    expect(hub.events()).toEqual(['PreToolUse', 'Stop']);
    expect(hub.count()).toBe(2);
    expect(await hub.fire('PostToolUse', {})).toEqual([]);
    rmSync(root, { recursive: true, force: true });
    const claude = mkdtempSync(join(tmpdir(), 'autocode-hub2-'));
    mkdirSync(join(claude, '.claude'), { recursive: true });
    writeFileSync(join(claude, '.claude', 'settings.json'), JSON.stringify({ permissions: {}, hooks: { PostToolUse: [{ matcher: 'Edit|Write', hooks: [{ type: 'command', command: 'fmt' }] }] } }));
    expect([...readProjectHooks(claude).keys()]).toEqual(['PostToolUse']);
    rmSync(claude, { recursive: true, force: true });
  });
});
