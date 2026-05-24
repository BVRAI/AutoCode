import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { detectProjectContext } from './ProjectContext.js';
import type { ProjectInstructions } from './ProjectInstructions.js';

export interface VerifyResult {
  ok: boolean;
  code: number | null;
  output: string;
}

const OUTPUT_CAP = 16 * 1024; // keep the tail — failures cluster at the end
const TIMEOUT_MS = 180_000;

// Resolve the verification command given the files actually touched this
// turn. Priority (narrowest match wins, broadest fallback last):
//   1. explicit `override` (config.verifyCommand) — always wins
//   2. the deepest AUTOCODE.md `verify:` directive that is a common
//      ancestor of every changed file
//   3. a root-level AUTOCODE.md `verify:` directive (fallback when changes
//      are scattered and no narrower ancestor matches all of them)
//   4. inferred command per project type (Phase 19 behaviour)
export function resolveVerifyCommandForFiles(
  root: string,
  override: string | undefined,
  instructions: ProjectInstructions[],
  changedFiles: string[],
): string | null {
  if (override && override.trim().length > 0) return override.trim();

  const withVerify = instructions.filter((i): i is ProjectInstructions & { verify: string } => {
    return typeof i.verify === 'string' && i.verify.trim().length > 0;
  });

  if (withVerify.length > 0 && changedFiles.length > 0) {
    // Find the deepest `verify` directive that is an ancestor of EVERY
    // changed file. Empty relativeDir ("") is the project-root catch-all
    // and is an ancestor of everything.
    let best: (ProjectInstructions & { verify: string }) | null = null;
    for (const inst of withVerify) {
      if (!changedFiles.every((p) => isUnderRelativeDir(p, inst.relativeDir))) continue;
      if (best === null || inst.depth > best.depth) best = inst;
    }
    if (best !== null) return best.verify.trim();
  }

  return inferVerifyCommand(root);
}

// Backward-compatible thin wrapper for callers that don't have file context
// (e.g. older code paths or tests). Skips the per-subdir directive lookup.
export function resolveVerifyCommand(root: string, override?: string): string | null {
  if (override && override.trim().length > 0) return override.trim();
  return inferVerifyCommand(root);
}

// True iff the project-relative file path lives under the given
// relativeDir. "" matches every file (project root).
function isUnderRelativeDir(filePath: string, relativeDir: string): boolean {
  if (relativeDir === '') return true;
  const dir = relativeDir.replace(/\\/g, '/').replace(/\/+$/, '');
  const file = filePath.replace(/\\/g, '/');
  return file === dir || file.startsWith(dir + '/');
}

function inferVerifyCommand(root: string): string | null {

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
