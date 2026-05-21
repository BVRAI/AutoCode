import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { detectProjectContext } from './ProjectContext.js';

export interface VerifyResult {
  ok: boolean;
  code: number | null;
  output: string;
}

const OUTPUT_CAP = 16 * 1024; // keep the tail — failures cluster at the end
const TIMEOUT_MS = 180_000;

// Resolve the command the harness runs to verify a project after file edits.
// An explicit override always wins. Otherwise the command is inferred
// conservatively — `null` means "no reliable command", and verification is
// then skipped rather than risk a false failure on an unrelated command.
export function resolveVerifyCommand(root: string, override?: string): string | null {
  if (override && override.trim().length > 0) return override.trim();

  const { types } = detectProjectContext(root);
  if (types.includes('node') || types.includes('typescript')) {
    const scripts = readPackageScripts(root);
    if (scripts.test && !isPlaceholderScript(scripts.test)) return 'npm test';
    if (scripts.build) return 'npm run build';
    if (existsSync(join(root, 'tsconfig.json'))) return 'npx tsc --noEmit';
    return null;
  }
  if (types.includes('rust')) return 'cargo check';
  if (types.includes('go')) return 'go build ./...';
  // python and others: too unreliable to guess — require explicit config.
  return null;
}

function readPackageScripts(root: string): Record<string, string> {
  try {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
    };
    return pkg.scripts ?? {};
  } catch {
    return {};
  }
}

// npm scaffolds a default `test` script that always exits 1 — treat it as
// "no test script" so verification falls through to build / tsc.
function isPlaceholderScript(script: string): boolean {
  return /no test specified/i.test(script);
}

// Run the verification command in a shell. Captures combined stdout+stderr
// (tail-capped), times out, and is killed if isCancelled() turns true. This
// is a trusted harness-issued command — it does NOT pass through the
// run_shell safety policy.
export function runVerification(
  command: string,
  root: string,
  isCancelled: () => boolean,
): Promise<VerifyResult> {
  return new Promise((resolve) => {
    let output = '';
    let settled = false;

    const append = (chunk: Buffer): void => {
      output += chunk.toString();
      if (output.length > OUTPUT_CAP) output = output.slice(-OUTPUT_CAP);
    };

    const child = spawn(command, {
      cwd: root,
      shell: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const finish = (code: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(poll);
      resolve({ ok: code === 0, code, output: output.trim() });
    };

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      output += '\n[verification timed out after 180s]';
      finish(null);
    }, TIMEOUT_MS);

    const poll = setInterval(() => {
      if (isCancelled() && !settled) {
        child.kill('SIGKILL');
        output += '\n[verification cancelled]';
        finish(null);
      }
    }, 200);

    child.stdout?.on('data', append);
    child.stderr?.on('data', append);
    child.on('error', (e) => {
      output += `\n[failed to run verification: ${e.message}]`;
      finish(null);
    });
    child.on('close', (code) => finish(code));
  });
}
