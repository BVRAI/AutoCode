import { spawn } from 'node:child_process';
import { resolveInsideRoot, toRelative } from '../util/pathSafety.js';
import { classifyCommand, type SafetyVerdict } from '../safety/SafetyPolicy.js';
import {
  optionalNumber,
  optionalString,
  requireString,
  type Tool,
  type ToolDefinition,
  type ToolExecutionContext,
  type ToolResult,
} from './types.js';

const DEFAULT_TIMEOUT = 120;
const MAX_OUTPUT_BYTES = 100_000;

const DEFINITION: ToolDefinition = {
  name: 'run_shell',
  description:
    'Run a shell command. Working directory is resolved relative to the project root. ' +
    'Commands are classified by the safety policy as allow / confirm / block. ' +
    'Destructive patterns (rm -rf /, format, diskpart, etc.) are hard-blocked. ' +
    'Risky-but-sometimes-valid patterns (git reset --hard, npm uninstall, etc.) require user confirmation. ' +
    'stdout and stderr are captured and returned (truncated to 100KB total).',
  inputSchema: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'The shell command to run.' },
      working_directory: { type: 'string', description: 'Subdirectory (relative). Default project root.' },
      timeout_seconds: { type: 'number', description: `Hard timeout in seconds. Default ${DEFAULT_TIMEOUT}.` },
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

function runCommand(command: string, cwd: string, timeoutMs: number): Promise<CommandResult> {
  return new Promise((resolve) => {
    const isWin = process.platform === 'win32';
    const child = isWin
      ? spawn('cmd.exe', ['/d', '/s', '/c', command], { cwd })
      : spawn('/bin/sh', ['-c', command], { cwd });

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
