// Post-edit syntax gate — SWE-agent's single strongest ablation (NeurIPS 2024:
// removing the lint gate collapsed solve rates 15%→3%). One syntactically
// broken edit sends the model down an error-chasing spiral; catching it at the
// tool boundary costs one spawn and saves a whole model round-trip.
//
// Design constraints:
//  - Dependency-free: checkers use what's already on the machine (node itself,
//    the TARGET project's typescript, any python on PATH) and SKIP gracefully
//    when a toolchain is absent — a skip is never an error.
//  - Syntax only, never types: a type error may be mid-refactor scaffolding;
//    a parse error is never intentional.
//  - Escape hatch: checkers have real false-positive modes (project TS older
//    than the syntax the model wrote, exotic dialects). After 2 consecutive
//    rejections on the same file the 3rd write applies with a warning — the
//    verify loop backstops whatever slips through.

import { spawn } from 'node:child_process';
import { rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { platform } from 'node:os';
import { extname, join } from 'node:path';
import type { ToolResult } from './types.js';

const CHECKER_TIMEOUT_MS = 5_000;
const DIAGNOSTICS_CAP = 2_000;
// Rejections 1 and 2 revert; the 3rd consecutive failure applies with a warning.
const MAX_CONSECUTIVE_REJECTIONS = 2;

export interface SyntaxCheck {
  ok: boolean;
  skipped: boolean; // no checker usable for this extension / toolchain
  checker: 'json' | 'node' | 'typescript' | 'python' | 'go' | 'rust' | 'none';
  diagnostics: string;
}

export type GateOutcome =
  | { action: 'pass' }
  | { action: 'reverted'; result: ToolResult }
  | { action: 'kept-with-warning'; warning: string };

// ── Gate entry point ────────────────────────────────────────────────────────

// Consecutive gate rejections per absolute path. Any pass resets; firing the
// escape hatch resets too so the next bad edit is gated again.
const consecutiveRejections = new Map<string, number>();

export function resetSyntaxGateStateForTests(): void {
  consecutiveRejections.clear();
}

export async function gateAfterWrite(opts: {
  target: string; // absolute path just written
  relPath: string; // for user-facing messages
  projectRoot: string;
  original: string; // pre-write content ('' when !existedBefore)
  existedBefore: boolean;
  content: string; // what was written (avoids a re-read)
}): Promise<GateOutcome> {
  if (process.env.AUTOCODE_NO_SYNTAX_GATE === '1') return { action: 'pass' };

  const check = await checkFileSyntax(opts.target, opts.content, opts.projectRoot);
  if (check.ok || check.skipped) {
    consecutiveRejections.delete(opts.target);
    return { action: 'pass' };
  }

  const rejections = (consecutiveRejections.get(opts.target) ?? 0) + 1;
  if (rejections > MAX_CONSECUTIVE_REJECTIONS) {
    // Escape hatch: the checker has now rejected this file 3 times in a row —
    // likely a false positive (or the model genuinely wants this content).
    // Apply the write, warn loudly, and re-arm the gate.
    consecutiveRejections.delete(opts.target);
    return {
      action: 'kept-with-warning',
      warning:
        `WARNING: the syntax checker (${check.checker}) still reports an error, but this edit ` +
        `was applied anyway after ${MAX_CONSECUTIVE_REJECTIONS} rejected attempts:\n${check.diagnostics}\n` +
        `If the checker is wrong (unsupported syntax dialect), continue; otherwise fix the syntax.`,
    };
  }
  consecutiveRejections.set(opts.target, rejections);

  // Revert with plain fs calls — the checkpoint snapshot was taken BEFORE the
  // write, so undo semantics are unchanged and no second snapshot is created.
  if (opts.existedBefore) {
    writeFileSync(opts.target, opts.original, 'utf8');
  } else {
    rmSync(opts.target, { force: true });
  }

  return {
    action: 'reverted',
    result: {
      summary: 'syntax error — edit rolled back',
      content:
        `The edit introduced a syntax error, so it was NOT applied — ` +
        (opts.existedBefore
          ? `${opts.relPath} was reverted to its previous content.`
          : `the new file ${opts.relPath} was removed.`) +
        `\n\n${check.checker} reported:\n${check.diagnostics}\n\n` +
        `Fix the syntax in your new content and retry the edit. The file on disk is ` +
        `unchanged, so your old_text anchor is still valid.`,
      isError: true,
      metadata: { syntaxGate: true, checker: check.checker, diagnostics: check.diagnostics },
    },
  };
}

// ── Checker dispatch ────────────────────────────────────────────────────────

export async function checkFileSyntax(
  absPath: string,
  content: string,
  projectRoot: string,
): Promise<SyntaxCheck> {
  const ext = extname(absPath).toLowerCase();
  switch (ext) {
    case '.json':
      return checkJson(content);
    case '.js':
    case '.mjs':
    case '.cjs':
      return checkWithNode(absPath, content, projectRoot);
    case '.ts':
    case '.tsx':
    case '.mts':
    case '.cts':
    case '.jsx':
      return checkWithTypeScript(absPath, content, projectRoot);
    case '.py':
      return checkWithPython(absPath);
    case '.go':
      return checkWithGofmt(absPath);
    case '.rs':
      return checkWithRustfmt(absPath);
    default:
      return { ok: true, skipped: true, checker: 'none', diagnostics: '' };
  }
}

function checkJson(content: string): SyntaxCheck {
  try {
    JSON.parse(content);
    return { ok: true, skipped: false, checker: 'json', diagnostics: '' };
  } catch (e) {
    return {
      ok: false,
      skipped: false,
      checker: 'json',
      diagnostics: cap(e instanceof Error ? e.message : String(e)),
    };
  }
}

// `node --check` parses without executing and picks the module goal from the
// extension + nearest package.json `type` (the file lives inside the target
// project, so the right package.json applies automatically). One real-world
// false positive remains: bundler projects using ESM syntax in plain .js with
// no `type: module` — detected by error signature and absolved by re-checking
// the content as an explicit ES module via stdin.
const ESM_IN_CJS_SIGNATURE =
  /Cannot use import statement outside a module|Unexpected token 'export'|Cannot use 'export'|await is only valid|Unexpected token 'import'/;

// JSX in a plain .js file (common in React projects) is a hard parse error
// for node — this is the signature it produces on the opening tag.
const JSX_SIGNATURE = /Unexpected token '<'/;

// Heuristic: content whose lines start with import/export is module-goal.
const LOOKS_ESM = /^\s*(?:import|export)\b/m;

async function checkWithNode(absPath: string, content: string, projectRoot: string): Promise<SyntaxCheck> {
  // node --check on a FILE only truly parses the CommonJS goal — when the
  // source contains top-level module syntax it exits 0 WITHOUT parsing the
  // rest (verified on node 22: a file starting with `export` passes --check
  // even with garbage below). ESM-looking content therefore gets a REAL
  // parse via stdin with an explicit module goal.
  const looksEsm = LOOKS_ESM.test(content);
  const first = looksEsm
    ? await runChecker(process.execPath, ['--check', '--input-type=module', '-'], { stdin: content })
    : await runChecker(process.execPath, ['--check', absPath], {});
  if (first.failedToRun) return { ok: true, skipped: true, checker: 'node', diagnostics: '' };
  if (first.code === 0) return { ok: true, skipped: false, checker: 'node', diagnostics: '' };

  // CJS file whose error says "this is really ESM" (dynamic import mixes,
  // template-string false negatives in the LOOKS_ESM heuristic) — re-check
  // under the module goal before rejecting.
  if (!looksEsm && ESM_IN_CJS_SIGNATURE.test(first.stderr)) {
    const retry = await runChecker(process.execPath, ['--check', '--input-type=module', '-'], {
      stdin: content,
    });
    if (!retry.failedToRun && retry.code === 0) {
      return { ok: true, skipped: false, checker: 'node', diagnostics: '' };
    }
  }

  // JSX-in-.js: node can never parse JSX, so its verdict is a false positive
  // for React projects that don't use the .jsx extension. Re-parse with
  // TypeScript in JSX mode (the .jsx suffix flips its ScriptKind); a clean
  // parse absolves the file. No TypeScript available → SKIP rather than
  // false-reject content we cannot verify.
  if (JSX_SIGNATURE.test(first.stderr)) {
    const tsCheck = checkWithTypeScript(`${absPath}.__jsx_probe.jsx`, content, projectRoot);
    if (tsCheck.skipped) return { ok: true, skipped: true, checker: 'node', diagnostics: '' };
    if (tsCheck.ok) return { ok: true, skipped: false, checker: 'typescript', diagnostics: '' };
    return tsCheck;
  }
  return { ok: false, skipped: false, checker: 'node', diagnostics: cap(first.stderr) };
}

// ── TypeScript ──────────────────────────────────────────────────────────────

interface TsLike {
  transpileModule(
    input: string,
    opts: {
      reportDiagnostics?: boolean;
      fileName?: string;
      compilerOptions?: Record<string, unknown>;
    },
  ): { diagnostics?: TsDiagnostic[] };
  flattenDiagnosticMessageText(msg: unknown, newline: string): string;
  getLineAndCharacterOfPosition?: unknown;
  JsxEmit: { Preserve: number };
  ScriptTarget: { ESNext: number };
  DiagnosticCategory: { Error: number };
}

interface TsDiagnostic {
  category: number;
  messageText: unknown;
  start?: number;
  file?: { getLineAndCharacterOfPosition(pos: number): { line: number; character: number } };
}

// The expensive part is loading the module (~100ms), so cache per project.
// Prefer the TARGET project's own typescript — it knows the syntax the project
// actually uses; autocode's bundled copy (dev installs only) is the fallback.
const tsCache = new Map<string, TsLike | null>();

function loadTypeScript(projectRoot: string): TsLike | null {
  const cached = tsCache.get(projectRoot);
  if (cached !== undefined) return cached;
  let ts: TsLike | null = null;
  try {
    ts = createRequire(join(projectRoot, 'package.json'))('typescript') as TsLike;
  } catch {
    try {
      ts = createRequire(import.meta.url)('typescript') as TsLike;
    } catch {
      ts = null;
    }
  }
  tsCache.set(projectRoot, ts);
  return ts;
}

export function resetTsCacheForTests(): void {
  tsCache.clear();
}

function checkWithTypeScript(absPath: string, content: string, projectRoot: string): SyntaxCheck {
  const ts = loadTypeScript(projectRoot);
  if (!ts) return { ok: true, skipped: true, checker: 'typescript', diagnostics: '' };
  // transpileModule is a PUBLIC API that by design never type-checks (isolated
  // single-file transpile) — its diagnostics are purely syntactic, which is
  // exactly the gate's contract.
  const out = ts.transpileModule(content, {
    reportDiagnostics: true,
    fileName: absPath,
    compilerOptions: { jsx: ts.JsxEmit.Preserve, target: ts.ScriptTarget.ESNext },
  });
  const errors = (out.diagnostics ?? []).filter((d) => d.category === ts.DiagnosticCategory.Error);
  if (errors.length === 0) return { ok: true, skipped: false, checker: 'typescript', diagnostics: '' };
  const lines = errors.slice(0, 10).map((d) => {
    const msg = ts.flattenDiagnosticMessageText(d.messageText, '\n');
    if (d.file && typeof d.start === 'number') {
      const pos = d.file.getLineAndCharacterOfPosition(d.start);
      return `line ${pos.line + 1}, col ${pos.character + 1}: ${msg}`;
    }
    return msg;
  });
  return { ok: false, skipped: false, checker: 'typescript', diagnostics: cap(lines.join('\n')) };
}

// ── Python ──────────────────────────────────────────────────────────────────

// ast.parse (not py_compile: no __pycache__ side effects). The exit-42 +
// stderr-sentinel protocol makes broken interpreter shims safe: Windows Store
// python stubs and version-manager shims can produce arbitrary exit codes,
// but none of them will emit our sentinel — anything that isn't exit 0 or
// (42 + sentinel) is treated as "no usable interpreter", i.e. skipped.
const PY_SENTINEL = 'AUTOCODE_SYNTAX_ERROR';
const PY_SCRIPT =
  'import ast,sys\n' +
  'try:\n' +
  '    ast.parse(open(sys.argv[1],"rb").read(), sys.argv[1])\n' +
  'except SyntaxError as e:\n' +
  `    sys.stderr.write('${PY_SENTINEL}\\n%s' % e); sys.exit(42)\n`;

let cachedPython: string | null | undefined; // undefined = not probed; null = none usable

export function resetPythonCacheForTests(): void {
  cachedPython = undefined;
}

async function checkWithPython(absPath: string): Promise<SyntaxCheck> {
  const candidates =
    cachedPython !== undefined && cachedPython !== null
      ? [cachedPython]
      : platform() === 'win32'
        ? ['py', 'python', 'python3']
        : ['python3', 'python'];
  if (cachedPython === null) return { ok: true, skipped: true, checker: 'python', diagnostics: '' };

  for (const cmd of candidates) {
    const r = await runChecker(cmd, ['-c', PY_SCRIPT, absPath], {});
    if (r.failedToRun) continue;
    if (r.code === 0) {
      cachedPython = cmd;
      return { ok: true, skipped: false, checker: 'python', diagnostics: '' };
    }
    if (r.code === 42 && r.stderr.includes(PY_SENTINEL)) {
      cachedPython = cmd;
      const diag = r.stderr.slice(r.stderr.indexOf(PY_SENTINEL) + PY_SENTINEL.length).trim();
      return { ok: false, skipped: false, checker: 'python', diagnostics: cap(diag) };
    }
    // Unexpected exit / output — broken shim or wrong binary; try the next.
  }
  if (cachedPython === undefined) cachedPython = null;
  return { ok: true, skipped: true, checker: 'python', diagnostics: '' };
}

// ── Go / Rust ───────────────────────────────────────────────────────────────

// gofmt -e is a pure parser (reports all syntax errors, no build context
// needed, no false positives from unresolved imports the way `go vet` has).
// Ships with every Go toolchain.
async function checkWithGofmt(absPath: string): Promise<SyntaxCheck> {
  const r = await runChecker('gofmt', ['-e', absPath], {});
  if (r.failedToRun) return { ok: true, skipped: true, checker: 'go', diagnostics: '' };
  if (r.code === 0) return { ok: true, skipped: false, checker: 'go', diagnostics: '' };
  return { ok: false, skipped: false, checker: 'go', diagnostics: cap(r.stderr) };
}

// rustfmt parses before formatting; --emit stdout leaves the file untouched
// and never fails on mere style. A parse failure exits non-zero with the
// error on stderr. (rustc has no stable parse-only mode — a full
// --emit=metadata build would false-reject on unresolved crates.)
async function checkWithRustfmt(absPath: string): Promise<SyntaxCheck> {
  const r = await runChecker('rustfmt', ['--emit', 'stdout', absPath], {});
  if (r.failedToRun) return { ok: true, skipped: true, checker: 'rust', diagnostics: '' };
  if (r.code === 0) return { ok: true, skipped: false, checker: 'rust', diagnostics: '' };
  return { ok: false, skipped: false, checker: 'rust', diagnostics: cap(r.stderr) };
}

// ── Process runner ──────────────────────────────────────────────────────────

interface CheckerRun {
  code: number | null;
  stderr: string;
  failedToRun: boolean; // spawn error or timeout — caller must treat as SKIP, not failure
}

export function runChecker(
  cmd: string,
  args: string[],
  opts: { stdin?: string; timeoutMs?: number },
): Promise<CheckerRun> {
  return new Promise((resolve) => {
    let stderr = '';
    let settled = false;
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(cmd, args, { stdio: [opts.stdin !== undefined ? 'pipe' : 'ignore', 'ignore', 'pipe'] });
    } catch {
      resolve({ code: null, stderr: '', failedToRun: true });
      return;
    }
    const finish = (r: CheckerRun): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* ignore */
      }
      finish({ code: null, stderr, failedToRun: true });
    }, opts.timeoutMs ?? CHECKER_TIMEOUT_MS);
    child.on('error', () => finish({ code: null, stderr, failedToRun: true }));
    child.stderr?.on('data', (d: Buffer) => {
      if (stderr.length < DIAGNOSTICS_CAP * 2) stderr += d.toString('utf8');
    });
    child.on('close', (code) => finish({ code, stderr, failedToRun: false }));
    if (opts.stdin !== undefined) {
      child.stdin?.write(opts.stdin);
      child.stdin?.end();
    }
  });
}

function cap(s: string): string {
  const t = s.trim();
  return t.length > DIAGNOSTICS_CAP ? t.slice(0, DIAGNOSTICS_CAP) + '\n… (truncated)' : t;
}
