import { spawn, type ChildProcess } from 'node:child_process';
import { resolveInsideRoot, toRelative } from '../util/pathSafety.js';
import { classifyCommand, type SafetyVerdict } from '../safety/SafetyPolicy.js';
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
const MAX_OUTPUT_BYTES = 100_000;
const BACKGROUND_GRACE_MS = 3_000;

// Background processes (e.g. dev servers) — killed when autocode exits so a
// `npm run dev` never outlives its session.
const bgChildren = new Set<ChildProcess>();
process.on('exit', () => {
  for (const c of bgChildren) {
    try {
      c.kill();
    } catch {
      /* ignore */
    }
  }
});

const DEFINITION: ToolDefinition = {
  name: 'run_shell',
  description:
    'Run a shell command. Working directory is resolved relative to the project root. ' +
    'Commands are classified by the safety policy as allow / confirm / block; destructive patterns ' +
    'and anything targeting paths outside the project or protected system zones are hard-blocked. ' +
    'Set background:true for long-running processes like a dev server — autocode starts it, captures ' +
    'a few seconds of startup output, and leaves it running (killed when the session ends). ' +
    'stdout and stderr are captured and returned (truncated to 100KB total).',
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
    if (verdict.kind === 'confirm') {
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

    if (background) {
      const bg = await runBackground(command, cwd);
      return {
        summary: `started in background (pid ${bg.pid ?? 'n/a'}) in ${toRelative(ctx.session.projectRoot, cwd) || '.'}`,
        content:
          (bg.exited
            ? `Process already exited (code ${bg.code ?? 'n/a'}).\n`
            : `Process is running (pid ${bg.pid ?? 'n/a'}); it will be stopped when the session ends.\n`) +
          (bg.output.length > 0 ? `--- startup output ---\n${bg.output}` : '(no startup output)'),
        isError: bg.exited && bg.code !== 0,
        metadata: { background: true, pid: bg.pid, exited: bg.exited, exitCode: bg.code },
      };
    }

    const result = await runCommand(command, cwd, timeoutSec * 1000);
    const display = trimOutput(result.stdout, result.stderr);
    const summary =
      `exit ${result.code ?? 'n/a'} in ${toRelative(ctx.session.projectRoot, cwd) || '.'}` +
      (result.timedOut ? ' (timed out)' : '');
    return {
      summary,
      content: display,
      isError: result.code !== 0 || result.timedOut,
      metadata: {
        exitCode: result.code,
        timedOut: result.timedOut,
        stdoutBytes: result.stdout.length,
        stderrBytes: result.stderr.length,
        verdict,
      },
    };
  }
}

interface CommandResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

interface BackgroundResult {
  pid?: number;
  output: string;
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
    const child = spawn(command, { cwd, shell: true });
    bgChildren.add(child);
    // A background process must not keep autocode's event loop alive on its
    // own — autocode's lifetime is governed by the REPL, not the dev server.
    child.unref();

    let output = '';
    let exited = false;
    let code: number | null = null;
    const cap = (d: Buffer): void => {
      if (output.length < MAX_OUTPUT_BYTES) output += d.toString('utf8');
    };
    child.stdout?.on('data', (d: Buffer) => {
      cap(d);
      process.stdout.write(d);
    });
    child.stderr?.on('data', (d: Buffer) => {
      cap(d);
      process.stderr.write(d);
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

    setTimeout(() => resolve({ pid: child.pid, output, exited, code }), BACKGROUND_GRACE_MS);
  });
}

function runCommand(command: string, cwd: string, timeoutMs: number): Promise<CommandResult> {
  return new Promise((resolve) => {
    // shell:true — see runBackground: avoids the argv re-escaping that
    // corrupted quoted arguments containing spaces.
    const child = spawn(command, { cwd, shell: true });

    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill('SIGKILL');
      } catch {
        /* ignore */
      }
    }, timeoutMs);

    child.stdout?.on('data', (d: Buffer) => {
      stdout += d.toString('utf8');
      process.stdout.write(d);
    });
    child.stderr?.on('data', (d: Buffer) => {
      stderr += d.toString('utf8');
      process.stderr.write(d);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ code: 1, stdout, stderr: stderr + `\n[spawn error] ${err.message}`, timedOut });
    });
  });
}

function trimOutput(stdout: string, stderr: string): string {
  const combined =
    (stdout.length > 0 ? `--- stdout ---\n${stdout}\n` : '') +
    (stderr.length > 0 ? `--- stderr ---\n${stderr}\n` : '');
  if (combined.length <= MAX_OUTPUT_BYTES) return combined || '(no output)';
  return combined.slice(0, MAX_OUTPUT_BYTES) + `\n… truncated (${combined.length - MAX_OUTPUT_BYTES} bytes more)`;
}
