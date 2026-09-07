import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveCheckStages } from '../../src/agent/VerifyStages.js';

describe('resolveCheckStages', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'autocode-stages-'));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('adds tsc and eslint for a TypeScript project with both configured', () => {
    writeFileSync(join(root, 'tsconfig.json'), '{}');
    writeFileSync(join(root, 'eslint.config.mjs'), 'export default [];');
    const stages = resolveCheckStages(root, ['src\\a.ts', './src/b.tsx', 'README.md']);
    expect(stages.map((s) => s.kind)).toEqual(['typecheck', 'lint']);
    expect(stages[0]!.command).toBe('npx tsc --noEmit -p tsconfig.json');
    expect(stages[1]!.command).toBe('npx eslint "src/a.ts" "src/b.tsx"');
    expect(stages[1]!.scoped).toBe(true);
  });

  it('skips a stage the verify command already covers and doc-only changes', () => {
    writeFileSync(join(root, 'tsconfig.json'), '{}');
    expect(resolveCheckStages(root, ['src/a.ts'], { skipCommands: ['npx tsc --noEmit'] })).toEqual([]);
    expect(resolveCheckStages(root, ['docs/guide.md', 'package.json'])).toEqual([]);
  });

  it('detects ruff and mypy from pyproject, go vet per package, and cargo check', () => {
    writeFileSync(join(root, 'pyproject.toml'), '[tool.ruff]\nline-length = 100\n[tool.mypy]\nstrict = true\n');
    const py = resolveCheckStages(root, ['pkg/mod.py']);
    expect(py.map((s) => s.command)).toEqual(['ruff check "pkg/mod.py"', 'mypy "pkg/mod.py"']);
    writeFileSync(join(root, 'go.mod'), 'module x\n');
    const go = resolveCheckStages(root, ['cmd/app/main.go', 'internal/util/u.go']);
    expect(go.map((s) => s.command)).toEqual(['go vet ./cmd/app/... ./internal/util/...']);
    writeFileSync(join(root, 'Cargo.toml'), '[package]\nname = "x"\n');
    expect(resolveCheckStages(root, ['src/lib.rs']).map((s) => s.command)).toEqual(['cargo check']);
    expect(resolveCheckStages(root, ['src/lib.rs'], { skipCommands: ['cargo test'] })).toEqual([]);
  });
});
