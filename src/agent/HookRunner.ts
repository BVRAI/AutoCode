// User-defined event hooks — the Anthropic playbook's "hooks" extension
// point. Hooks are local shell commands the user registers in
// ~/.autocode/config.json that fire on PreToolUse / PostToolUse / Stop.
//
// Exit-code semantics match Claude Code's canonical implementation:
//   0     — success, continue normally
//   2     — blocking error (PreToolUse only): the tool call is refused
//           and the hook's stderr is fed back to the model as the error
//           so it can adapt
//   other — advisory failure: logged, surfaced to the user, but does
//           NOT block the action
//
// Hooks are local commands (no HTTP endpoints, no MCP-as-handler yet)
// and run SERIALLY in declared order — keeps determinism and lets the
// model see hook output in a predictable sequence.

import { execSync, spawn } from 'node:child_process';

export type HookEvent = 'pre_tool' | 'post_tool' | 'stop';

export interface HookSpec {
  /** `|`-separated list of exact tool names, or `*` (or absent) to match all.
   *  Ignored for `stop` hooks. */
  match?: string;
  /** Shell command to run. */
  command: string;
  /** Hard timeout in milliseconds; SIGKILL on overrun. Default 30s. */
  timeoutMs?: number;
}

export interface HookContext {
  event: HookEvent;
  toolName?: string;
  toolArgs?: Record<string, unknown>;
  toolResultText?: string;
  toolResultIsError?: boolean;
  projectRoot: string;
  sessionId: string;
}

export interface HookOutcome {
  event: HookEvent;
  command: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** True iff this hook returned exit code 2 — only meaningful for pre_tool. */
  blocked: boolean;
  durationMs: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const OUTPUT_CAP_BYTES = 16 * 1024;
const TOOL_RESULT_ENV_CAP_BYTES = 8 * 1024;

/** Pure: does this spec apply to the given tool name? */
export function hookMatches(spec: HookSpec, toolName: string | undefined): boolean {
  const m = spec.match?.trim();
  if (!m || m === '*') return true;
  if (!toolName) return false;
  for (const part of m.split('|')) {
    if (part.trim() === toolName) return true;
  }
  return false;
}

/** Run all matching hooks for an event, serially, returning per-hook outcomes. */
export async function runHooksForEvent(
  specs: HookSpec[] | undefined,
  ctx: HookContext,
): Promise<HookOutcome[]> {
  if (!specs || specs.length === 0) return [];
  const outcomes: HookOutcome[] = [];
  for (const spec of specs) {
    if (ctx.event !== 'stop' && !hookMatches(spec, ctx.toolName)) continue;
    outcomes.push(await runOne(spec, ctx));
  }
  return outcomes;
}

function runOne(spec: HookSpec, ctx: HookContext): Promise<HookOutcome> {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const timeoutMs = spec.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const env = buildHookEnv(ctx);
    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const child = spawn(spec.command, {
      cwd: ctx.projectRoot,
      shell: true,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
      // On POSIX, become process-group leader so we can kill the whole tree
      // with kill(-pid). Windows uses `taskkill /T` instead (see treeKill).
      detached: process.platform !== 'win32',
    });

    const timer = setTimeout(() => {
      timedOut = true;
      treeKill(child.pid);
      // Belt-and-suspenders: if `close` doesn't fire within a short grace
      // period after the kill (can happen if the shell's child descendants
      // hold the pipes open even after the shell dies), resolve anyway so
      // the run doesn't hang on a runaway hook.
      setTimeout(() => finish(null), 1500);
    }, timeoutMs);

    const cap = (chunk: Buffer, sink: (s: string) => void): void => {
      sink(chunk.toString('utf8'));
    };
    child.stdout?.on('data', (d: Buffer) =>
      cap(d, (s) => {
        if (stdout.length < OUTPUT_CAP_BYTES) stdout += s;
      }),
    );
    child.stderr?.on('data', (d: Buffer) =>
      cap(d, (s) => {
        if (stderr.length < OUTPUT_CAP_BYTES) stderr += s;
      }),
    );

    const finish = (code: number | null): void => {
      clearTimeout(timer);
      const trimmed = (s: string): string =>
        s.length > OUTPUT_CAP_BYTES
          ? s.slice(0, OUTPUT_CAP_BYTES) + `\n[…hook output truncated at ${OUTPUT_CAP_BYTES} bytes]`
          : s;
      resolve({
        event: ctx.event,
        command: spec.command,
        exitCode: code,
        stdout: trimmed(stdout),
        stderr: trimmed(stderr),
        timedOut,
        blocked: ctx.event === 'pre_tool' && code === 2,
        durationMs: Date.now() - t0,
      });
    };

    child.on('error', (err) => {
      stderr += `\n[hook spawn error] ${err.message}`;
      finish(null);
    });
    child.on('close', (code) => finish(code));
  });
}

// Kill the spawned shell AND any descendants. Plain SIGKILL on the shell
// leaves its children (e.g. the actual `node` process the user's hook
// invoked) running with the pipes still open — so the parent's `close`
// event never fires and we'd hang. Tree-kill avoids that.
function treeKill(pid: number | undefined): void {
  if (pid === undefined) return;
  if (process.platform === 'win32') {
    try {
      execSync(`taskkill /pid ${pid} /T /F`, { stdio: 'ignore', windowsHide: true });
    } catch {
      /* may already be dead — that's fine */
    }
    return;
  }
  // POSIX — kill the whole process group (we spawned with detached:true so
  // pid is the group leader; -pid addresses the group).
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* ignore */
    }
  }
}

function buildHookEnv(ctx: HookContext): Record<string, string> {
  const out: Record<string, string> = {
    AUTOCODE_HOOK_EVENT: ctx.event,
    AUTOCODE_HOOK_PROJECT_ROOT: ctx.projectRoot,
    AUTOCODE_HOOK_SESSION_ID: ctx.sessionId,
  };
  if (ctx.toolName !== undefined) out.AUTOCODE_HOOK_TOOL_NAME = ctx.toolName;
  if (ctx.toolArgs !== undefined) {
    try {
      out.AUTOCODE_HOOK_TOOL_ARGS_JSON = JSON.stringify(ctx.toolArgs);
    } catch {
      out.AUTOCODE_HOOK_TOOL_ARGS_JSON = '{}';
    }
  }
  if (ctx.toolResultText !== undefined) {
    out.AUTOCODE_HOOK_TOOL_RESULT = ctx.toolResultText.slice(0, TOOL_RESULT_ENV_CAP_BYTES);
  }
  if (ctx.toolResultIsError !== undefined) {
    out.AUTOCODE_HOOK_TOOL_RESULT_IS_ERROR = ctx.toolResultIsError ? '1' : '0';
  }
  return out;
}

/** Convenience: collapse hook outcomes into the synthetic tool_result error
 *  content that AgentLoop injects when a pre_tool hook blocks. Only the
 *  outcomes that actually blocked contribute. */
export function blockingReason(outcomes: HookOutcome[]): string | null {
  const blockers = outcomes.filter((o) => o.blocked);
  if (blockers.length === 0) return null;
  return blockers
    .map((o) => `Hook \`${o.command}\` blocked this tool call:\n${o.stderr.trim() || '(no message)'}`)
    .join('\n\n');
}
