import { spawn } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { platform } from 'node:os';
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

  // Node/TypeScript — most common, kept first.
  if (types.includes('node') || types.includes('typescript')) {
    const scripts = readPackageScripts(root);
    if (scripts.test && !isPlaceholderScript(scripts.test)) return 'npm test';
    if (scripts.build) return 'npm run build';
    if (existsSync(join(root, 'tsconfig.json'))) return 'npx tsc --noEmit';
    return null;
  }

  // Rust — upgrade to `cargo test` when a tests/ directory exists (integration
  // tests are the conventional Rust pattern; running them catches logic bugs
  // the bare type-check misses). Without tests/, fall back to compile-only.
  if (types.includes('rust')) {
    if (isDir(join(root, 'tests'))) return 'cargo test';
    return 'cargo check';
  }

  // Go — upgrade to `go test ./...` when any *_test.go is present (Go's
  // convention puts tests alongside source files). Without test files, fall
  // back to compile-only.
  if (types.includes('go')) {
    if (hasFileAtRoot(root, (n) => /_test\.go$/i.test(n))) return 'go test ./...';
    return 'go build ./...';
  }

  // Python — only fire when there's clear evidence of a pytest setup.
  // Bare pyproject.toml/requirements.txt isn't enough — many Python projects
  // have those without runnable tests, and a spurious `pytest` invocation
  // that exits non-zero would derail the agent.
  if (types.includes('python') && hasPytestSetup(root)) {
    return 'pytest';
  }

  // JVM — Gradle wrapper preferred (most reproducible), then Maven.
  if (types.includes('jvm')) {
    const isWin = platform() === 'win32';
    if (existsSync(join(root, isWin ? 'gradlew.bat' : 'gradlew'))) {
      return isWin ? 'gradlew.bat test' : './gradlew test';
    }
    // POSIX gradlew may also be present on a Windows checkout — fall back to it.
    if (existsSync(join(root, 'gradlew'))) {
      return './gradlew test';
    }
    if (existsSync(join(root, 'pom.xml'))) return 'mvn -q test';
    return null;
  }

  // C++ — detected separately (not in ProjectContext markers) via CMakeLists.txt.
  // Build-only verification: `cmake --build build` after a one-shot configure.
  // Test execution is too project-specific (CTest, raw ninja targets, custom
  // scripts) to infer safely — leave that to an AUTOCODE.md `verify:` directive.
  if (existsSync(join(root, 'CMakeLists.txt'))) {
    return 'cmake -B build && cmake --build build';
  }

  // Unknown / no usable signal — require explicit config.
  return null;
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

// Single readdir of the project root, predicate-matched. Used for quick
// "does this project have *_test.go / test_*.py / etc." checks without
// triggering a full recursive scan. Aider/Exercism conventions put test
// files at the root or under tests/, both of which a root scan + one
// targeted subdir check (when needed) cover cheaply.
function hasFileAtRoot(root: string, predicate: (name: string) => boolean): boolean {
  try {
    for (const name of readdirSync(root)) {
      if (predicate(name)) return true;
    }
  } catch {
    /* unreadable root — caller treats as no match */
  }
  return false;
}

// Python pytest detection: any of the standard config files, a
// `[tool.pytest` table in pyproject.toml, a conftest.py at root, OR a test
// file matching pytest's discovery patterns (test_*.py / *_test.py) at root
// or under a tests/ subdir.
function hasPytestSetup(root: string): boolean {
  if (existsSync(join(root, 'pytest.ini'))) return true;
  if (existsSync(join(root, 'pytest.cfg'))) return true;
  if (existsSync(join(root, 'conftest.py'))) return true;
  try {
    const pyproject = readFileSync(join(root, 'pyproject.toml'), 'utf8');
    if (/\[tool\.pytest/.test(pyproject)) return true;
  } catch {
    /* no pyproject.toml or unreadable — fall through */
  }
  const testNameRe = /^(test_.+\.py|.+_test\.py|conftest\.py)$/i;
  if (hasFileAtRoot(root, (n) => testNameRe.test(n))) return true;
  for (const sub of ['tests', 'test']) {
    const dir = join(root, sub);
    if (isDir(dir) && hasFileAtRoot(dir, (n) => testNameRe.test(n))) return true;
  }
  return false;
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
