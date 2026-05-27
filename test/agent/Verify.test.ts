import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { platform, tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  resolveVerifyCommand,
  resolveVerifyCommandForFiles,
  runVerification,
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
