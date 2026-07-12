import { describe, expect, it } from 'vitest';
import { isReadOnlyShellCommand } from '../../src/agent/AgentLoop.js';

describe('isReadOnlyShellCommand (run_shell → verify-loop gate)', () => {
  it('classifies pure reads as read-only', () => {
    expect(isReadOnlyShellCommand('ls -la')).toBe(true);
    expect(isReadOnlyShellCommand('cat src/index.ts')).toBe(true);
    expect(isReadOnlyShellCommand('git status')).toBe(true);
    expect(isReadOnlyShellCommand('git log --oneline -5')).toBe(true);
    expect(isReadOnlyShellCommand('grep -r "foo" src | head -5')).toBe(true);
    expect(isReadOnlyShellCommand('git diff && git status')).toBe(true);
    expect(isReadOnlyShellCommand('')).toBe(true);
  });

  it('classifies anything that can write as mutating', () => {
    expect(isReadOnlyShellCommand('sed -i s/a/b/ file.txt')).toBe(false);
    expect(isReadOnlyShellCommand('npm install')).toBe(false);
    expect(isReadOnlyShellCommand('mv a.txt b.txt')).toBe(false);
    expect(isReadOnlyShellCommand('touch new.txt')).toBe(false);
    expect(isReadOnlyShellCommand('python generate.py')).toBe(false);
    expect(isReadOnlyShellCommand('git checkout -b feature')).toBe(false);
    expect(isReadOnlyShellCommand('git apply patch.diff')).toBe(false);
  });

  it('any output redirect makes a command mutating — even a "read"', () => {
    expect(isReadOnlyShellCommand('cat a.txt > b.txt')).toBe(false);
    expect(isReadOnlyShellCommand('echo hi >> log.txt')).toBe(false);
    expect(isReadOnlyShellCommand('ls > files.txt')).toBe(false);
  });

  it('a mutating segment poisons an otherwise read-only chain', () => {
    expect(isReadOnlyShellCommand('ls && rm -rf dist')).toBe(false);
    expect(isReadOnlyShellCommand('git status; npm run build')).toBe(false);
  });
});
