import { spawn } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { killTree, spawnOptionsForTree } from '../util/processTree.js';
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

// A verification plan for one round of the verify loop.
//  - `command` runs every round. When scoping applied it targets only the
//    tests related to the changed files, so fix-loop retries are fast.
//  - `fullCommand` (when non-null) is the unscoped suite, run ONCE after
//    `command` passes — scoped tests passing while something else silently
//    broke is exactly the regression the verify loop exists to catch, so
//    scoped-only is never accepted as success.
export interface VerifyPlan {
  command: string;
  fullCommand: string | null;
  source: 'override' | 'directive' | 'inferred' | 'inferred-scoped';
}

// Resolve the verification plan given the files actually touched this turn.
// Priority (narrowest match wins, broadest fallback last):
//   1. explicit `override` (config.verifyCommand) — always wins, never scoped
//   2. the deepest AUTOCODE.md `verify:` directive that is a common
//      ancestor of every changed file — never scoped (user's exact command)
//   3. a root-level AUTOCODE.md `verify:` directive
//   4. inferred command per project type — scoped to the changed files when
//      the ecosystem makes that safe (see scopeInferredCommand)
export function resolveVerifyPlanForFiles(
  root: string,
  override: string | undefined,
  instructions: ProjectInstructions[],
  changedFiles: string[],
): VerifyPlan | null {
  if (override && override.trim().length > 0) {
    return { command: override.trim(), fullCommand: null, source: 'override' };
  }

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
    if (best !== null) return { command: best.verify.trim(), fullCommand: null, source: 'directive' };
  }

  // No per-file context (e.g. the mutation happened through run_shell, where
  // the harness can't know which files changed) — fall back to the project
  // root's directive rather than skipping directives entirely.
  if (withVerify.length > 0 && changedFiles.length === 0) {
    const rootDirective = withVerify.find((i) => i.relativeDir === '');
    if (rootDirective) {
      return { command: rootDirective.verify.trim(), fullCommand: null, source: 'directive' };
    }
  }

  const inferred = inferVerifyCommand(root);
  if (!inferred) return null;
  const scoped = scopeInferredCommand(root, inferred, changedFiles);
  if (scoped.isScoped) {
    return { command: scoped.command, fullCommand: inferred, source: 'inferred-scoped' };
  }
  return { command: inferred, fullCommand: null, source: 'inferred' };
}

// Back-compat wrapper — always returns the FULL (unscoped) command, exactly
// the pre-VerifyPlan behaviour, for callers/tests without round semantics.
export function resolveVerifyCommandForFiles(
  root: string,
  override: string | undefined,
  instructions: ProjectInstructions[],
  changedFiles: string[],
): string | null {
  const plan = resolveVerifyPlanForFiles(root, override, instructions, changedFiles);
  if (!plan) return null;
  return plan.fullCommand ?? plan.command;
}

// ── Scoped test selection (Agentless-style regression selection) ────────────

// Try to narrow an INFERRED whole-suite command to the tests related to the
// changed files. Heuristics degrade to the full suite (the safe default) —
// never to a wrong scope. Doc-only changes (.md/.txt) don't influence the
// decision.
export function scopeInferredCommand(
  root: string,
  inferred: string,
  changedFiles: string[],
): { command: string; isScoped: boolean } {
  const full = { command: inferred, isScoped: false };
  const files = changedFiles
    .map((p) => p.replace(/\\/g, '/').replace(/^\.\//, ''))
    .filter((p) => !/\.(md|txt)$/i.test(p));
  if (files.length === 0) return full;

  if (inferred === 'go test ./...') return scopeGo(files) ?? full;
  if (inferred === 'pytest') return scopePytest(root, files) ?? full;
  if (inferred === 'npm test') return scopeNpmTest(root, files) ?? full;
  // Whole-program commands (npm run build, tsc --noEmit, cargo, gradle/mvn,
  // cmake) are never scoped — file→target mapping is brittle or meaningless.
  return full;
}

function scopeGo(files: string[]): { command: string; isScoped: boolean } | null {
  if (!files.every((f) => f.endsWith('.go'))) return null; // go.mod etc. → full
  const dirs = new Set<string>();
  for (const f of files) {
    const i = f.lastIndexOf('/');
    if (i === -1) return null; // root-level file — ./... is already the scope
    dirs.add(f.slice(0, i));
  }
  const args = [...dirs].sort().map((d) => `./${d}/...`);
  return { command: `go test ${args.join(' ')}`, isScoped: true };
}

const PY_TEST_NAME = /^(test_.+|.+_test)\.py$/i;

function scopePytest(root: string, files: string[]): { command: string; isScoped: boolean } | null {
  const targets = new Set<string>();
  for (const f of files) {
    if (!f.endsWith('.py')) return null;
    const base = f.slice(f.lastIndexOf('/') + 1);
    if (base === 'conftest.py') return null; // fixture change affects everything
    if (PY_TEST_NAME.test(base)) {
      targets.add(f);
      continue;
    }
    const dir = f.includes('/') ? f.slice(0, f.lastIndexOf('/')) : '';
    const stem = base.replace(/\.py$/i, '');
    const prefix = dir === '' ? '' : `${dir}/`;
    const candidates = [
      `${prefix}test_${stem}.py`,
      `${prefix}${stem}_test.py`,
      `${prefix}tests/test_${stem}.py`,
      `tests/test_${stem}.py`,
      `test/test_${stem}.py`,
    ];
    const hit = candidates.find((c) => existsSync(join(root, c)));
    if (!hit) return null; // any unmapped source file → full suite
    targets.add(hit);
  }
  if (targets.size === 0) return null;
  return { command: `pytest ${quoteAll([...targets].sort())}`, isScoped: true };
}

const JSTS_TEST_NAME = /\.(test|spec)\.[cm]?[jt]sx?$/i;
const JSTS_SOURCE = /\.[cm]?[jt]sx?$/i;
const TEST_FILE_EXTS = ['.test.ts', '.test.tsx', '.test.js', '.test.jsx', '.spec.ts', '.spec.tsx', '.spec.js', '.spec.jsx'];

function scopeNpmTest(root: string, files: string[]): { command: string; isScoped: boolean } | null {
  const runner = detectNodeTestRunner(root);
  if (!runner) return null;

  const targets = new Set<string>();
  for (const f of files) {
    if (!JSTS_SOURCE.test(f) || f.endsWith('.d.ts')) return null;
    if (JSTS_TEST_NAME.test(f)) {
      if (!existsSync(join(root, f))) return null;
      targets.add(f);
      continue;
    }
    const dir = f.includes('/') ? f.slice(0, f.lastIndexOf('/')) : '';
    const base = f.slice(f.lastIndexOf('/') + 1).replace(JSTS_SOURCE, '');
    const prefix = dir === '' ? '' : `${dir}/`;
    const candidates: string[] = [];
    for (const e of TEST_FILE_EXTS) {
      candidates.push(`${prefix}${base}${e}`, `${prefix}__tests__/${base}${e}`);
    }
    // src/ → test|tests/ mirror layout (autocode's own: src/agent/Verify.ts
    // → test/agent/Verify.test.ts).
    if (f.startsWith('src/')) {
      const restDir = dir.slice('src/'.length);
      const mid = restDir === '' ? '' : `${restDir}/`;
      for (const mirror of ['test', 'tests']) {
        for (const e of TEST_FILE_EXTS) candidates.push(`${mirror}/${mid}${base}${e}`);
      }
    }
    const hit = candidates.find((c) => existsSync(join(root, c)));
    if (!hit) return null;
    targets.add(hit);
  }
  if (targets.size === 0) return null;
  const list = quoteAll([...targets].sort());
  return {
    command: runner === 'vitest' ? `npx vitest run ${list}` : `npx jest ${list}`,
    isScoped: true,
  };
}

// Windows editors and PowerShell commonly write package.json with a UTF-8
// BOM, which JSON.parse rejects — strip it or silently misdetect the project.
function stripBom(s: string): string {
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

function detectNodeTestRunner(root: string): 'vitest' | 'jest' | null {
  try {
    const pkg = JSON.parse(stripBom(readFileSync(join(root, 'package.json'), 'utf8'))) as {
      scripts?: Record<string, string>;
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    const testScript = pkg.scripts?.test ?? '';
    if (deps['vitest'] || /\bvitest\b/.test(testScript)) return 'vitest';
    if (deps['jest'] || /\bjest\b/.test(testScript)) return 'jest';
  } catch {
    /* unreadable package.json → cannot scope safely */
  }
  return null;
}

function quoteAll(paths: string[]): string {
  return paths.map((p) => (p.includes(' ') ? `"${p}"` : p)).join(' ');
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
  //
  // Skipped under the bench harness: there the harness configures + builds with
  // the toolchain env the agent's sandbox doesn't carry, so a self-build here
  // false-fails on environment grounds (not a code bug). That phantom failure
  // gets fed back as "fix the failures," and the agent burns its whole budget
  // chasing a build error in already-correct code. The harness runs the
  // authoritative tests itself, so cpp self-verify is redundant as well as broken.
  if (existsSync(join(root, 'CMakeLists.txt')) && process.env.AUTOCODE_BENCH_MODE !== '1') {
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
    const pkg = JSON.parse(stripBom(readFileSync(join(root, 'package.json'), 'utf8'))) as {
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
      ...spawnOptionsForTree(),
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
        killTree(child);
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
