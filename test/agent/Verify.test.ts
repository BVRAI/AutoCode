import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { platform, tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  resolveVerifyCommand,
  resolveVerifyCommandForFiles,
  resolveVerifyPlanForFiles,
  runVerification,
  scopeInferredCommand,
} from '../../src/agent/Verify.js';
import type { ProjectInstructions } from '../../src/agent/ProjectInstructions.js';

describe('resolveVerifyCommand', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'autocode-verify-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const pkg = (scripts: Record<string, string>): void =>
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts }));

  it('uses an explicit override regardless of project type', () => {
    expect(resolveVerifyCommand(dir, 'make check')).toBe('make check');
  });

  it('trims an explicit override and ignores a blank one', () => {
    pkg({ test: 'vitest run' });
    expect(resolveVerifyCommand(dir, '  npm run lint  ')).toBe('npm run lint');
    expect(resolveVerifyCommand(dir, '   ')).toBe('npm test');
  });

  it('prefers a real test script for a node project', () => {
    pkg({ test: 'vitest run', build: 'tsc' });
    expect(resolveVerifyCommand(dir)).toBe('npm test');
  });

  it('falls through to build when the test script is npm\'s placeholder', () => {
    pkg({ test: 'echo "Error: no test specified" && exit 1', build: 'tsc' });
    expect(resolveVerifyCommand(dir)).toBe('npm run build');
  });

  it('falls through to tsc when there is only a tsconfig', () => {
    writeFileSync(join(dir, 'package.json'), '{}');
    writeFileSync(join(dir, 'tsconfig.json'), '{}');
    expect(resolveVerifyCommand(dir)).toBe('npx tsc --noEmit');
  });

  it('returns null for a node project with nothing to run', () => {
    writeFileSync(join(dir, 'package.json'), '{}');
    expect(resolveVerifyCommand(dir)).toBeNull();
  });

  it('infers cargo check for a rust project with no tests/ dir', () => {
    writeFileSync(join(dir, 'Cargo.toml'), '[package]');
    expect(resolveVerifyCommand(dir)).toBe('cargo check');
  });

  it('upgrades to cargo test when a tests/ directory exists', () => {
    writeFileSync(join(dir, 'Cargo.toml'), '[package]');
    mkdirSync(join(dir, 'tests'));
    writeFileSync(join(dir, 'tests', 'integration.rs'), '');
    expect(resolveVerifyCommand(dir)).toBe('cargo test');
  });

  it('infers go build for a go project with no test files', () => {
    writeFileSync(join(dir, 'go.mod'), 'module x');
    expect(resolveVerifyCommand(dir)).toBe('go build ./...');
  });

  it('upgrades to go test ./... when a *_test.go file exists at root', () => {
    writeFileSync(join(dir, 'go.mod'), 'module x');
    writeFileSync(join(dir, 'main.go'), 'package main');
    writeFileSync(join(dir, 'main_test.go'), 'package main');
    expect(resolveVerifyCommand(dir)).toBe('go test ./...');
  });

  it('returns null for a python project with pyproject.toml but no test setup', () => {
    writeFileSync(join(dir, 'pyproject.toml'), '[project]\nname = "x"');
    expect(resolveVerifyCommand(dir)).toBeNull();
  });

  it('infers pytest when pyproject.toml has a [tool.pytest] table', () => {
    writeFileSync(
      join(dir, 'pyproject.toml'),
      '[project]\nname = "x"\n\n[tool.pytest.ini_options]\nminversion = "6.0"',
    );
    expect(resolveVerifyCommand(dir)).toBe('pytest');
  });

  it('infers pytest when pytest.ini exists', () => {
    writeFileSync(join(dir, 'pyproject.toml'), '[project]\nname = "x"');
    writeFileSync(join(dir, 'pytest.ini'), '[pytest]');
    expect(resolveVerifyCommand(dir)).toBe('pytest');
  });

  it('infers pytest from a root-level test_*.py file', () => {
    writeFileSync(join(dir, 'pyproject.toml'), '[project]\nname = "x"');
    writeFileSync(join(dir, 'test_widget.py'), 'def test_x(): pass');
    expect(resolveVerifyCommand(dir)).toBe('pytest');
  });

  it('infers pytest from an Exercism-style *_test.py at root', () => {
    // Matches the Aider polyglot layout: foo.py + foo_test.py at root, with
    // only requirements.txt (no pyproject.toml).
    writeFileSync(join(dir, 'requirements.txt'), '');
    writeFileSync(join(dir, 'proverb.py'), '');
    writeFileSync(join(dir, 'proverb_test.py'), '');
    expect(resolveVerifyCommand(dir)).toBe('pytest');
  });

  it('infers pytest from test files under a tests/ subdirectory', () => {
    writeFileSync(join(dir, 'pyproject.toml'), '[project]\nname = "x"');
    mkdirSync(join(dir, 'tests'));
    writeFileSync(join(dir, 'tests', 'test_widget.py'), '');
    expect(resolveVerifyCommand(dir)).toBe('pytest');
  });

  it('infers cmake build for a project with CMakeLists.txt', () => {
    writeFileSync(join(dir, 'CMakeLists.txt'), 'cmake_minimum_required(VERSION 3.10)');
    expect(resolveVerifyCommand(dir)).toBe('cmake -B build && cmake --build build');
  });

  it('infers mvn -q test for a Maven project', () => {
    writeFileSync(join(dir, 'pom.xml'), '<project/>');
    expect(resolveVerifyCommand(dir)).toBe('mvn -q test');
  });

  it('prefers the Gradle wrapper over Maven when both are present', () => {
    writeFileSync(join(dir, 'pom.xml'), '<project/>');
    writeFileSync(join(dir, 'build.gradle'), '');
    writeFileSync(join(dir, 'gradlew'), '#!/bin/sh');
    if (platform() === 'win32') writeFileSync(join(dir, 'gradlew.bat'), '');
    const expected = platform() === 'win32' ? 'gradlew.bat test' : './gradlew test';
    expect(resolveVerifyCommand(dir)).toBe(expected);
  });

  it('returns null for a JVM project with no build wrapper or pom', () => {
    // Only build.gradle present (no wrapper, no pom) — too ambiguous to infer.
    writeFileSync(join(dir, 'build.gradle'), '');
    expect(resolveVerifyCommand(dir)).toBeNull();
  });

  it('node project is preferred over a stray CMakeLists.txt', () => {
    // A polyglot repo with both package.json and CMakeLists.txt should still
    // verify via npm — the order matters so we don't trigger cmake on a
    // primarily-node project that happens to ship native bindings.
    pkg({ test: 'vitest run' });
    writeFileSync(join(dir, 'CMakeLists.txt'), 'cmake_minimum_required(VERSION 3.10)');
    expect(resolveVerifyCommand(dir)).toBe('npm test');
  });
});

describe('resolveVerifyCommandForFiles — per-subdir directives', () => {
  // Build a minimal ProjectInstructions entry with an optional verify.
  function inst(relativeDir: string, verify?: string): ProjectInstructions {
    return {
      fileName: 'AUTOCODE.md',
      path: '/_unused_/AUTOCODE.md',
      relativeDir,
      depth: relativeDir === '' ? 0 : relativeDir.split('/').length,
      content: '',
      truncated: false,
      bytes: 0,
      priorityLabel: 'autocode project instructions',
      isAuthoritative: false,
      ...(verify ? { verify } : {}),
    };
  }

  it('explicit override wins over every directive', () => {
    const r = resolveVerifyCommandForFiles(
      '/proj',
      'make check',
      [inst('src/api', 'pytest')],
      ['src/api/views.py'],
    );
    expect(r).toBe('make check');
  });

  it('picks the deepest verify directive that is an ancestor of every changed file', () => {
    const insts = [inst('', 'npm test'), inst('src', 'tsc'), inst('src/api', 'pytest')];
    const r = resolveVerifyCommandForFiles('/proj', undefined, insts, [
      'src/api/views.py',
      'src/api/models.py',
    ]);
    expect(r).toBe('pytest');
  });

  it('falls back to a broader common ancestor when changes span multiple subtrees', () => {
    const insts = [inst('', 'root-cmd'), inst('src', 'src-cmd'), inst('src/api', 'api-cmd'), inst('src/web', 'web-cmd')];
    const r = resolveVerifyCommandForFiles('/proj', undefined, insts, [
      'src/api/views.py',
      'src/web/index.tsx',
    ]);
    expect(r).toBe('src-cmd');
  });

  it('falls back to root verify when no narrower ancestor matches all files', () => {
    const insts = [inst('', 'root-cmd'), inst('src/api', 'api-cmd')];
    const r = resolveVerifyCommandForFiles('/proj', undefined, insts, [
      'src/api/views.py',
      'docs/readme.md',
    ]);
    expect(r).toBe('root-cmd');
  });

  it('falls through to inference when no directives present and no override', () => {
    // tmp project with no package.json — inference returns null.
    const r = resolveVerifyCommandForFiles(tmpdir(), undefined, [], ['anywhere.txt']);
    // Whether it's null or some default depends on the tmp dir; just confirm
    // we didn't surprise the caller with a thrown exception.
    expect(typeof r === 'string' || r === null).toBe(true);
  });

  it('ignores directives without a verify field', () => {
    const insts = [inst('src/api')]; // no verify
    const r = resolveVerifyCommandForFiles(tmpdir(), undefined, insts, ['src/api/x.py']);
    expect(r === null || typeof r === 'string').toBe(true);
  });
});

describe('runVerification', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'autocode-verify-run-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('reports ok for a command that exits 0', async () => {
    const r = await runVerification('node -e "process.exit(0)"', dir, () => false);
    expect(r.ok).toBe(true);
    expect(r.code).toBe(0);
  });

  it('reports failure and captures output for a non-zero exit', async () => {
    const r = await runVerification(
      'node -e "console.log(\'boom\'); process.exit(3)"',
      dir,
      () => false,
    );
    expect(r.ok).toBe(false);
    expect(r.code).toBe(3);
    expect(r.output).toContain('boom');
  });
});

describe('scopeInferredCommand', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'autocode-scope-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  // ── go ──
  it('go: scopes changed .go files to their package dirs', () => {
    const r = scopeInferredCommand(dir, 'go test ./...', ['pkg/auth/login.go', 'pkg/db/conn.go']);
    expect(r.isScoped).toBe(true);
    expect(r.command).toBe('go test ./pkg/auth/... ./pkg/db/...');
  });

  it('go: a go.mod change falls back to the full suite', () => {
    const r = scopeInferredCommand(dir, 'go test ./...', ['go.mod', 'pkg/auth/login.go']);
    expect(r.isScoped).toBe(false);
    expect(r.command).toBe('go test ./...');
  });

  it('go: a root-level file keeps ./... unscoped', () => {
    const r = scopeInferredCommand(dir, 'go test ./...', ['main.go']);
    expect(r.isScoped).toBe(false);
  });

  // ── pytest ──
  it('pytest: a changed test file runs itself', () => {
    const r = scopeInferredCommand(dir, 'pytest', ['tests/test_auth.py']);
    expect(r.isScoped).toBe(true);
    expect(r.command).toBe('pytest tests/test_auth.py');
  });

  it('pytest: a sibling test_x.py is selected for a source change', () => {
    mkdirSync(join(dir, 'pkg'), { recursive: true });
    writeFileSync(join(dir, 'pkg', 'test_auth.py'), '');
    const r = scopeInferredCommand(dir, 'pytest', ['pkg/auth.py']);
    expect(r.isScoped).toBe(true);
    expect(r.command).toBe('pytest pkg/test_auth.py');
  });

  it('pytest: the root tests/ mirror is selected', () => {
    mkdirSync(join(dir, 'tests'), { recursive: true });
    writeFileSync(join(dir, 'tests', 'test_engine.py'), '');
    const r = scopeInferredCommand(dir, 'pytest', ['engine.py']);
    expect(r.isScoped).toBe(true);
    expect(r.command).toBe('pytest tests/test_engine.py');
  });

  it('pytest: an unmapped source or conftest change falls back to full', () => {
    expect(scopeInferredCommand(dir, 'pytest', ['mystery.py']).isScoped).toBe(false);
    expect(scopeInferredCommand(dir, 'pytest', ['conftest.py']).isScoped).toBe(false);
  });

  // ── npm test ──
  function nodeProject(runner: 'vitest' | 'jest'): void {
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({ scripts: { test: `${runner} run` }, devDependencies: { [runner]: '^1' } }),
    );
  }

  it('vitest: src/a/b.ts maps to the test/ mirror', () => {
    nodeProject('vitest');
    mkdirSync(join(dir, 'test', 'agent'), { recursive: true });
    writeFileSync(join(dir, 'test', 'agent', 'Verify.test.ts'), '');
    const r = scopeInferredCommand(dir, 'npm test', ['src/agent/Verify.ts']);
    expect(r.isScoped).toBe(true);
    expect(r.command).toBe('npx vitest run test/agent/Verify.test.ts');
  });

  it('vitest: a same-dir spec sibling is found', () => {
    nodeProject('vitest');
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'src', 'util.spec.ts'), '');
    const r = scopeInferredCommand(dir, 'npm test', ['src/util.ts']);
    expect(r.isScoped).toBe(true);
    expect(r.command).toBe('npx vitest run src/util.spec.ts');
  });

  it('jest: detected via devDependencies and scoped', () => {
    nodeProject('jest');
    mkdirSync(join(dir, 'src', '__tests__'), { recursive: true });
    writeFileSync(join(dir, 'src', '__tests__', 'core.test.js'), '');
    const r = scopeInferredCommand(dir, 'npm test', ['src/core.js']);
    expect(r.isScoped).toBe(true);
    expect(r.command).toBe('npx jest src/__tests__/core.test.js');
  });

  it('tolerates a UTF-8 BOM in package.json (PowerShell-written projects)', () => {
    // PowerShell 5.1's utf8 encoding writes a BOM; JSON.parse rejects it raw.
    writeFileSync(
      join(dir, 'package.json'),
      '﻿' + JSON.stringify({ scripts: { test: 'vitest run' }, devDependencies: { vitest: '^1' } }),
    );
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'src', 'util.spec.ts'), '');
    const r = scopeInferredCommand(dir, 'npm test', ['src/util.ts']);
    expect(r.isScoped).toBe(true);
  });

  it('npm test with an unidentifiable runner is not scoped', () => {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'mocha' } }));
    const r = scopeInferredCommand(dir, 'npm test', ['src/a.ts']);
    expect(r.isScoped).toBe(false);
  });

  it('an unmapped source file falls back to the full suite', () => {
    nodeProject('vitest');
    const r = scopeInferredCommand(dir, 'npm test', ['src/no-test-anywhere.ts']);
    expect(r.isScoped).toBe(false);
  });

  it('doc-only changes never scope', () => {
    nodeProject('vitest');
    const r = scopeInferredCommand(dir, 'npm test', ['README.md', 'docs/notes.txt']);
    expect(r.isScoped).toBe(false);
  });

  it('whole-program commands are never scoped', () => {
    for (const cmd of ['npm run build', 'npx tsc --noEmit', 'cargo test', 'mvn -q test']) {
      expect(scopeInferredCommand(dir, cmd, ['src/a.ts']).isScoped).toBe(false);
    }
  });
});

describe('resolveVerifyPlanForFiles', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'autocode-plan-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const inst = (relativeDir: string, verify: string): ProjectInstructions => ({
    fileName: 'AUTOCODE.md',
    path: join(dir, relativeDir, 'AUTOCODE.md'),
    relativeDir,
    depth: relativeDir === '' ? 0 : relativeDir.split('/').length,
    content: '',
    isAuthoritative: false,
    verify,
  });

  it('an explicit override is never scoped', () => {
    const plan = resolveVerifyPlanForFiles(dir, 'make check', [], ['src/a.go']);
    expect(plan).toEqual({ command: 'make check', fullCommand: null, source: 'override' });
  });

  it('an AUTOCODE.md directive is never scoped', () => {
    const plan = resolveVerifyPlanForFiles(dir, undefined, [inst('', 'npm run custom')], ['a.go']);
    expect(plan).toEqual({ command: 'npm run custom', fullCommand: null, source: 'directive' });
  });

  // Inference upgrades `go build` to `go test ./...` only when a root-level
  // *_test.go exists — the fixtures below provide one.
  it('an inferred go command gets scoped with the full command retained', () => {
    writeFileSync(join(dir, 'go.mod'), 'module x\n');
    writeFileSync(join(dir, 'main_test.go'), 'package main\n');
    const plan = resolveVerifyPlanForFiles(dir, undefined, [], ['pkg/a/x.go']);
    expect(plan).toEqual({
      command: 'go test ./pkg/a/...',
      fullCommand: 'go test ./...',
      source: 'inferred-scoped',
    });
  });

  it('fullCommand is null when scoping did not apply', () => {
    writeFileSync(join(dir, 'go.mod'), 'module x\n');
    writeFileSync(join(dir, 'main_test.go'), 'package main\n');
    const plan = resolveVerifyPlanForFiles(dir, undefined, [], ['main.go']);
    expect(plan).toEqual({ command: 'go test ./...', fullCommand: null, source: 'inferred' });
  });

  it('resolveVerifyCommandForFiles wrapper still returns the full command', () => {
    writeFileSync(join(dir, 'go.mod'), 'module x\n');
    writeFileSync(join(dir, 'main_test.go'), 'package main\n');
    const cmd = resolveVerifyCommandForFiles(dir, undefined, [], ['pkg/a/x.go']);
    expect(cmd).toBe('go test ./...');
  });
});
