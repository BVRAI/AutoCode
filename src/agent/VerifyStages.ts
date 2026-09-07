// Typecheck / lint stages that run before the project's test command after a
// turn changed files (Phase 4.1). Detected from the project, scoped to the
// changed files where the tool allows it, and never duplicated when the
// verify command already is the checker. Stages are cheap compared with a
// test suite and catch the errors a test run reports late or not at all.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface CheckStage {
  kind: 'typecheck' | 'lint';
  /** Short label for the spinner and the feedback message ("typecheck (tsc)"). */
  label: string;
  command: string;
  /** True when the command targets only the changed files. */
  scoped: boolean;
}

const TS_EXT = /\.(ts|tsx|mts|cts)$/i;
const JS_EXT = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/i;
const PY_EXT = /\.py$/i;
const GO_EXT = /\.go$/i;
const RS_EXT = /\.rs$/i;
const MAX_SCOPED_FILES = 40;

const ESLINT_CONFIGS = [
  'eslint.config.js',
  'eslint.config.mjs',
  'eslint.config.cjs',
  'eslint.config.ts',
  'eslint.config.mts',
  'eslint.config.cts',
  '.eslintrc',
  '.eslintrc.js',
  '.eslintrc.cjs',
  '.eslintrc.json',
  '.eslintrc.yml',
  '.eslintrc.yaml',
];

export function checkStagesDisabled(): boolean {
  return process.env.AUTOCODE_NO_CHECK_STAGES === '1';
}

/**
 * The stages worth running for these changed files, in order. `skipCommands`
 * are commands the verify loop runs anyway (the verify plan), so a stage that
 * would repeat one is dropped.
 */
export function resolveCheckStages(root: string, changedFiles: string[], opts: { skipCommands?: string[] } = {}): CheckStage[] {
  const files = [...new Set(changedFiles.map(normalizeRel))].filter((f) => f.length > 0 && !isDocLike(f));
  if (files.length === 0) return [];
  const skip = (opts.skipCommands ?? []).map((c) => c.trim().toLowerCase());
  const skipped = (prefix: string): boolean => skip.some((c) => c.startsWith(prefix));
  const out: CheckStage[] = [];

  // TypeScript: whole-project typecheck (tsc has no useful per-file mode).
  if (files.some((f) => TS_EXT.test(f)) && existsSync(join(root, 'tsconfig.json')) && !skipped('npx tsc') && !skipped('tsc')) {
    out.push({ kind: 'typecheck', label: 'typecheck (tsc)', command: 'npx tsc --noEmit -p tsconfig.json', scoped: false });
  }

  // ESLint on the changed JS/TS files when the project configures it.
  const jsFiles = files.filter((f) => JS_EXT.test(f));
  if (jsFiles.length > 0 && ESLINT_CONFIGS.some((c) => existsSync(join(root, c))) && !skipped('npx eslint') && !skipped('eslint')) {
    out.push({ kind: 'lint', label: 'lint (eslint)', command: `npx eslint ${quoteAll(jsFiles.slice(0, MAX_SCOPED_FILES))}`, scoped: true });
  }

  // Python: ruff when configured, mypy when configured.
  const pyFiles = files.filter((f) => PY_EXT.test(f));
  if (pyFiles.length > 0) {
    const pyproject = readIfExists(join(root, 'pyproject.toml'));
    const setupCfg = readIfExists(join(root, 'setup.cfg'));
    const hasRuff = existsSync(join(root, 'ruff.toml')) || existsSync(join(root, '.ruff.toml')) || /\[tool\.ruff/.test(pyproject);
    const hasMypy = existsSync(join(root, 'mypy.ini')) || existsSync(join(root, '.mypy.ini')) || /\[tool\.mypy/.test(pyproject) || /^\[mypy\]/m.test(setupCfg);
    if (hasRuff && !skipped('ruff')) out.push({ kind: 'lint', label: 'lint (ruff)', command: `ruff check ${quoteAll(pyFiles.slice(0, MAX_SCOPED_FILES))}`, scoped: true });
    if (hasMypy && !skipped('mypy')) out.push({ kind: 'typecheck', label: 'typecheck (mypy)', command: `mypy ${quoteAll(pyFiles.slice(0, MAX_SCOPED_FILES))}`, scoped: true });
  }

  // Go: vet the changed packages.
  const goFiles = files.filter((f) => GO_EXT.test(f));
  if (goFiles.length > 0 && existsSync(join(root, 'go.mod')) && !skipped('go vet')) {
    const dirs = new Set<string>();
    let rootLevel = false;
    for (const f of goFiles) {
      const i = f.lastIndexOf('/');
      if (i < 0) rootLevel = true;
      else dirs.add(f.slice(0, i));
    }
    const targets = rootLevel ? './...' : [...dirs].sort().map((d) => `./${d}/...`).join(' ');
    out.push({ kind: 'lint', label: 'vet (go vet)', command: `go vet ${targets}`, scoped: !rootLevel });
  }

  // Rust: cargo check unless the verify command compiles the crate anyway.
  if (files.some((f) => RS_EXT.test(f)) && existsSync(join(root, 'Cargo.toml')) && !skipped('cargo')) {
    out.push({ kind: 'typecheck', label: 'typecheck (cargo check)', command: 'cargo check', scoped: false });
  }

  return out;
}

function normalizeRel(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\.\//, '').trim();
}

function isDocLike(p: string): boolean {
  return /\.(md|mdx|txt|rst|json|ya?ml|toml|lock|csv|svg|png|jpe?g|gif|ico)$/i.test(p);
}

function quoteAll(files: string[]): string {
  return files.map((f) => `"${f}"`).join(' ');
}

function readIfExists(path: string): string {
  try {
    return existsSync(path) ? readFileSync(path, 'utf8') : '';
  } catch {
    return '';
  }
}
