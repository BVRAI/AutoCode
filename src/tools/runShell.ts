import { spawn, type ChildProcess } from 'node:child_process';
import { resolveInsideRoot, toRelative } from '../util/pathSafety.js';
import { classifyCommand, type SafetyVerdict } from '../safety/SafetyPolicy.js';
import { annotateSandboxFailures, sandboxEnabled, wrapForSandbox } from '../safety/Sandbox.js';
import { killTree, spawnOptionsForTree } from '../util/processTree.js';
import {
  optionalBoolean,
  optionalNumber,
  optionalString,
  requireString,
  type Tool,
  type ToolDefinition,
  type ToolExecutionContext,
  type ToolResult,
} from './types.js';

const DEFAULT_TIMEOUT = 300;
// Model-facing output budget. ~30K chars ≈ 7-8K tokens — the industry norm
// (Claude Code middle-truncates at 30K chars). The old 100K cap could flood
// an eighth of a 200K-token context window with a single noisy command.
export const MAX_MODEL_OUTPUT_CHARS = 30_000;
// stderr gets its own reserved budget, applied BEFORE stdout claims the
// remainder — a flood of stdout must never starve the error text out of
// the result.
const STDERR_RESERVED_CHARS = 10_000;
// Middle-truncation split: the tail gets the larger share because test
// runners and compilers print their failure summary at the END of the run.
const HEAD_FRACTION = 0.3;
// Per-stream in-memory bound during capture — enough to middle-truncate
// accurately without holding a runaway process's full output in memory.
const CAPTURE_HEAD_CHARS = 200_000;
const CAPTURE_TAIL_CHARS = 200_000;
// Background (dev-server) startup capture is head-only: early startup errors
// appear at the start, and only a few seconds of output are captured anyway.
const BG_STARTUP_CHARS = 20_000;
const BACKGROUND_GRACE_MS = 3_000;

// Background processes (e.g. dev servers) — killed when autocode exits so a
// `npm run dev` never outlives its session.
const bgChildren = new Set<ChildProcess>();
process.on('exit', () => {
  for (const c of bgChildren) killTree(c);
});

const DEFINITION: ToolDefinition = {
  name: 'run_shell',
  description:
    'Run a shell command. Working directory is resolved relative to the project root. ' +
    'Commands are classified by the safety policy as allow / confirm / block; destructive patterns ' +
    'and anything targeting paths outside the project or protected system zones are hard-blocked. ' +
    'Set background:true for long-running processes like a dev server — autocode starts it, captures ' +
    'a few seconds of startup output, and leaves it running (killed when the session ends). ' +
    'stdout and stderr are captured with separate budgets and middle-truncated to ~30,000 characters ' +
    'total — the beginning and end are kept and an omission marker shows how much was cut (failure ' +
    'summaries at the end of test/build output survive). Full byte counts are in metadata. ' +
    'On Windows the shell is cmd.exe: quote with double quotes (single quotes are literal characters), ' +
    'keep commands on one line, and write anything longer than a one-liner to a file first with write_file.',
  inputSchema: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'The shell command to run.' },
      working_directory: { type: 'string', description: 'Subdirectory (relative). Default project root.' },
      timeout_seconds: { type: 'number', description: `Hard timeout in seconds. Default ${DEFAULT_TIMEOUT}.` },
      background: { type: 'boolean', description: 'Run as a long-lived process (dev server). Default false.' },
    },
    required: ['command'],
  },
};

export class RunShellTool implements Tool {
  readonly definition = DEFINITION;

  async execute(args: Record<string, unknown>, ctx: ToolExecutionContext): Promise<ToolResult> {
    const command = requireString(args, 'command');
    const wd = optionalString(args, 'working_directory');
    const timeoutSec = optionalNumber(args, 'timeout_seconds') ?? DEFAULT_TIMEOUT;
    const background = optionalBoolean(args, 'background') ?? false;

    const verdict: SafetyVerdict = classifyCommand(command, ctx.session.projectRoot);
    if (verdict.kind === 'block') {
      return {
        summary: `blocked: ${verdict.reason}`,
        content: `Command refused by safety policy: ${verdict.reason}\nPattern: ${verdict.pattern ?? '(n/a)'}`,
        isError: true,
        metadata: { verdict },
      };
    }
    let judged: string | null = null;
    if (verdict.kind === 'confirm' && ctx.judge) {
      // Auto mode's reviewer tier: a cheap model may clear the command so
      // the user is only interrupted for what it would not vouch for.
      try {
        const j = await ctx.judge({ command, reason: verdict.reason });
        if (j.decision === 'allow') judged = j.reason || 'cleared by the auto-mode reviewer';
      } catch {
        judged = null;
      }
    }
    if (verdict.kind === 'confirm' && judged === null) {
      if (!ctx.confirm) {
        return {
          summary: `confirm required: ${verdict.reason}`,
          content: `Command requires user confirmation (${verdict.reason}) but no interactive prompt is attached.`,
          isError: true,
          metadata: { verdict },
        };
      }
      const ok = await ctx.confirm(
        `[autocode] Risky command (${verdict.reason}): ${command}\nRun it?`,
      );
      if (!ok) {
        return {
          summary: 'user declined',
          content: 'User declined to run the command.',
          isError: true,
          metadata: { verdict, declined: true },
        };
      }
    }

    const cwd = wd
      ? resolveInsideRoot(ctx.session.projectRoot, wd)
      : ctx.session.projectRoot;

    // Opt-in OS sandbox (config `sandbox.enabled`): the command string is
    // rewritten to run inside the runtime's fence; a missing runtime is
    // reported once and the command runs as it would have.
    let toRun = command;
    let sandboxed = false;
    let sandboxNote: string | undefined;
    if (sandboxEnabled(ctx.session.sandbox)) {
      const w = await wrapForSandbox(command, { config: ctx.session.sandbox!, projectRoot: ctx.session.projectRoot });
      toRun = w.command;
      sandboxed = w.sandboxed;
      sandboxNote = w.note;
    }
    const notes = [judged ? `[auto mode] risky command allowed without asking: ${judged}` : '', sandboxNote ? `[${sandboxNote}]` : '']
      .filter((n) => n.length > 0)
      .join('\n');
    const prefix = notes.length > 0 ? `${notes}\n` : '';

    if (background) {
      const bg = await runBackground(toRun, cwd);
      return {
        summary: `started in background (pid ${bg.pid ?? 'n/a'}) in ${toRelative(ctx.session.projectRoot, cwd) || '.'}`,
        content:
          prefix +
          (bg.exited
            ? `Process already exited (code ${bg.code ?? 'n/a'}).\n`
            : `Process is running (pid ${bg.pid ?? 'n/a'}); it will be stopped when the session ends.\n`) +
          (bg.output.length > 0
            ? `--- startup output ---\n${bg.output}${bg.clipped ? '\n… [startup output truncated]' : ''}`
            : '(no startup output)'),
        isError: bg.exited && bg.code !== 0,
        metadata: { background: true, pid: bg.pid, exited: bg.exited, exitCode: bg.code, sandboxed },
      };
    }

    const result = await runCommand(toRun, cwd, timeoutSec * 1000);
    if (sandboxed) result.stderr.tail = annotateSandboxFailures(command, result.stderr.tail);
    const trimmed = trimOutput(result.stdout, result.stderr);
    const summary =
      `exit ${result.code ?? 'n/a'} in ${toRelative(ctx.session.projectRoot, cwd) || '.'}` +
      (result.timedOut ? ' (timed out)' : '') +
      (sandboxed ? ' (sandboxed)' : '');
    return {
      summary,
      content: prefix + trimmed.content,
      isError: result.code !== 0 || result.timedOut,
      metadata: {
        exitCode: result.code,
        timedOut: result.timedOut,
        stdoutBytes: result.stdout.bytes,
        stderrBytes: result.stderr.bytes,
        stdoutChars: result.stdout.chars,
        stderrChars: result.stderr.chars,
        stdoutTruncated: trimmed.stdoutTruncated,
        stderrTruncated: trimmed.stderrTruncated,
        verdict,
        sandboxed,
        judged: judged !== null,
      },
    };
  }
}

// One captured output stream. `head`/`tail` hold the retained slices (the
// middle may already have been dropped during capture); `chars`/`bytes` are
// the TRUE totals the process produced, kept honest for metadata even when
// the text itself was clipped.
export interface CapturedStream {
  head: string;
  tail: string;
  chars: number; // UTF-16 code units produced
  bytes: number; // raw bytes produced
}

// Bounded stream capture: fill `head` up to CAPTURE_HEAD_CHARS, then roll a
// CAPTURE_TAIL_CHARS window over the rest. This lets trimOutput reconstruct
// a faithful middle-truncated view without ever holding a runaway process's
// full output in memory (the old code accumulated unbounded strings).
export function createCapture(): { push(d: Buffer): void; snapshot(): CapturedStream } {
  let head = '';
  let tail = '';
  let chars = 0;
  let bytes = 0;
  return {
    push(d: Buffer): void {
      const s = d.toString('utf8');
      chars += s.length;
      bytes += d.length;
      if (head.length < CAPTURE_HEAD_CHARS) {
        const room = CAPTURE_HEAD_CHARS - head.length;
        head += s.slice(0, room);
        if (s.length > room) tail = (tail + s.slice(room)).slice(-CAPTURE_TAIL_CHARS);
      } else {
        tail = (tail + s).slice(-CAPTURE_TAIL_CHARS);
      }
    },
    snapshot(): CapturedStream {
      return { head, tail, chars, bytes };
    },
  };
}

interface CommandResult {
  code: number | null;
  stdout: CapturedStream;
  stderr: CapturedStream;
  timedOut: boolean;
}

interface BackgroundResult {
  pid?: number;
  output: string;
  clipped: boolean;
  exited: boolean;
  code: number | null;
}

// Spawn a long-lived process (dev server). Captures a few seconds of startup
// output so the agent can see early errors, then returns while it keeps
// running. The process is killed when autocode exits.
function runBackground(command: string, cwd: string): Promise<BackgroundResult> {
  return new Promise((resolve) => {
    // shell:true lets Node invoke the platform shell correctly — on Windows it
    // passes the command verbatim to cmd.exe (no argv re-escaping that would
    // mangle embedded quotes); on POSIX it uses /bin/sh -c.
    const child = spawn(command, { cwd, shell: true, ...spawnOptionsForTree() });
    bgChildren.add(child);
    // A background process must not keep autocode's event loop alive on its
    // own — autocode's lifetime is governed by the REPL, not the dev server.
    child.unref();

    let output = '';
    let clipped = false;
    let exited = false;
    let code: number | null = null;
    // Head-only cap: for a dev server the interesting failures (port in use,
    // missing module) print immediately, so the start is the right end to keep.
    const cap = (d: Buffer): void => {
      if (output.length >= BG_STARTUP_CHARS) {
        clipped = true;
        return;
      }
      const s = d.toString('utf8');
      const room = BG_STARTUP_CHARS - output.length;
      output += s.slice(0, room);
      if (s.length > room) clipped = true;
    };
    child.stdout?.on('data', (d: Buffer) => {
      cap(d);
    });
    child.stderr?.on('data', (d: Buffer) => {
      cap(d);
    });
    child.on('close', (c) => {
      exited = true;
      code = c;
      bgChildren.delete(child);
    });
    child.on('error', (err) => {
      exited = true;
      output += `\n[spawn error] ${err.message}`;
      bgChildren.delete(child);
    });

    setTimeout(() => resolve({ pid: child.pid, output, clipped, exited, code }), BACKGROUND_GRACE_MS);
  });
}

// After a timeout kill, how long to wait for 'close' before settling anyway —
// a grandchild that survived the shell can keep the pipes open for hours.
const KILL_GRACE_MS = 2_000;

function runCommand(command: string, cwd: string, timeoutMs: number): Promise<CommandResult> {
  return new Promise((resolve) => {
    // shell:true — see runBackground: avoids the argv re-escaping that
    // corrupted quoted arguments containing spaces.
    const child = spawn(command, { cwd, shell: true, ...spawnOptionsForTree() });

    const outCap = createCapture();
    const errCap = createCapture();
    let timedOut = false;
    let settled = false;
    const settle = (code: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout: outCap.snapshot(), stderr: errCap.snapshot(), timedOut });
    };

    const timer = setTimeout(() => {
      timedOut = true;
      errCap.push(Buffer.from(`\n[timed out after ${Math.round(timeoutMs / 1000)}s — process tree killed]`, 'utf8'));
      killTree(child);
      // Never wait on 'close' after a kill: settle once the grace period passes.
      setTimeout(() => settle(null), KILL_GRACE_MS).unref?.();
    }, timeoutMs);

    child.stdout?.on('data', (d: Buffer) => {
      outCap.push(d);
    });
    child.stderr?.on('data', (d: Buffer) => {
      errCap.push(d);
    });
    child.on('close', (code) => settle(code));
    child.on('error', (err) => {
      errCap.push(Buffer.from(`\n[spawn error] ${err.message}`, 'utf8'));
      settle(1);
    });
  });
}

function omissionMarker(n: number): string {
  return `\n… [${n} chars omitted — output was middle-truncated; failures usually appear near the end] …\n`;
}

// Render one captured stream within a char budget, keeping the beginning and
// the end. The tail gets the larger share (HEAD_FRACTION is the head's) —
// test runners and compilers put the verdict at the end, and losing it is
// exactly the failure mode the old head-only truncation had.
export function middleTruncate(
  stream: CapturedStream,
  budget: number,
): { text: string; truncated: boolean } {
  const captureGap = stream.chars - stream.head.length - stream.tail.length;
  if (captureGap === 0) {
    // Contiguous — the capture kept everything the process produced.
    const full = stream.head + stream.tail;
    if (full.length <= budget) return { text: full, truncated: false };
    const headKeep = Math.floor(budget * HEAD_FRACTION);
    const tailKeep = budget - headKeep;
    return {
      text:
        full.slice(0, headKeep) +
        omissionMarker(full.length - headKeep - tailKeep) +
        full.slice(full.length - tailKeep),
      truncated: true,
    };
  }
  // The capture itself already dropped a middle span — always truncated,
  // and the marker must count what capture dropped plus what we cut now.
  const headKeep = Math.min(stream.head.length, Math.floor(budget * HEAD_FRACTION));
  const tailKeep = Math.min(stream.tail.length, Math.max(0, budget - headKeep));
  return {
    text:
      stream.head.slice(0, headKeep) +
      omissionMarker(stream.chars - headKeep - tailKeep) +
      stream.tail.slice(stream.tail.length - tailKeep),
    truncated: true,
  };
}

// Combine both streams under the total model-facing budget. stderr is
// budgeted FIRST (up to its reserve) so a flood of stdout can never push the
// error text out; stdout takes whatever the rendered stderr left over.
export function trimOutput(
  stdout: CapturedStream,
  stderr: CapturedStream,
): { content: string; stdoutTruncated: boolean; stderrTruncated: boolean } {
  const err = middleTruncate(stderr, Math.min(STDERR_RESERVED_CHARS, MAX_MODEL_OUTPUT_CHARS));
  const out = middleTruncate(stdout, Math.max(0, MAX_MODEL_OUTPUT_CHARS - err.text.length));
  const sections =
    (out.text.length > 0 ? `--- stdout ---\n${out.text}\n` : '') +
    (err.text.length > 0 ? `--- stderr ---\n${err.text}\n` : '');
  return {
    content: sections || '(no output)',
    stdoutTruncated: out.truncated,
    stderrTruncated: err.truncated,
  };
}
