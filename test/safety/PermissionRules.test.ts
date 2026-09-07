import { describe, it, expect } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decide, mergeRules, normalizeRules, readProjectRules } from '../../src/safety/PermissionRules.js';
import { trustSensitiveContent, trustPrompt } from '../../src/agent/Trust.js';

describe('permission rules', () => {
  const rules = normalizeRules({ allow: ['Bash(git *)', 'Read'], ask: ['Bash(npm publish*)'], deny: ['Bash(rm -rf *)', 'Read(.env)'] });

  it('deny beats ask beats allow, with Tool(prefix *) and bare-tool matchers', () => {
    expect(decide(rules, 'run_shell', { command: 'git status' })).toEqual({ decision: 'allow', rule: 'Bash(git *)' });
    expect(decide(rules, 'run_shell', { command: 'rm -rf build' })).toEqual({ decision: 'deny', rule: 'Bash(rm -rf *)' });
    expect(decide(rules, 'run_shell', { command: 'npm publish --tag next' })).toEqual({ decision: 'ask', rule: 'Bash(npm publish*)' });
    expect(decide(rules, 'read_file', { path: '.env' })).toEqual({ decision: 'deny', rule: 'Read(.env)' });
    expect(decide(rules, 'read_file', { path: 'src/a.ts' })).toEqual({ decision: 'allow', rule: 'Read' });
    expect(decide(rules, 'edit_file', { path: 'src/a.ts' }).decision).toBeNull();
    expect(decide({}, 'run_shell', { command: 'ls' }).decision).toBeNull();
  });

  it('normalizes junk, merges sets and reads project files under either name', () => {
    expect(normalizeRules('nope')).toEqual({});
    expect(normalizeRules({ allow: ['x', 3, ''] }).allow).toEqual(['x']);
    const merged = mergeRules({ allow: ['a'] }, null, { deny: ['b'] });
    expect(merged).toEqual({ allow: ['a'], ask: [], deny: ['b'] });
    const root = mkdtempSync(join(tmpdir(), 'autocode-perm-'));
    mkdirSync(join(root, '.claude'), { recursive: true });
    writeFileSync(join(root, '.claude', 'settings.json'), JSON.stringify({ permissions: { allow: ['Bash(npm test)'] } }));
    expect(readProjectRules(root).allow).toEqual(['Bash(npm test)']);
    mkdirSync(join(root, '.autocode'), { recursive: true });
    writeFileSync(join(root, '.autocode', 'permissions.json'), JSON.stringify({ deny: ['Bash(curl *)'] }));
    expect(readProjectRules(root).deny).toEqual(['Bash(curl *)']);
    rmSync(root, { recursive: true, force: true });
  });
});

describe('trust gate', () => {
  it('lists the repo automation that needs trust, including verify directives', () => {
    const root = mkdtempSync(join(tmpdir(), 'autocode-trust-'));
    expect(trustSensitiveContent(root)).toEqual([]);
    mkdirSync(join(root, '.autocode'), { recursive: true });
    writeFileSync(join(root, '.autocode', 'hooks.json'), '{}');
    writeFileSync(join(root, '.mcp.json'), '{}');
    writeFileSync(join(root, 'AUTOCODE.md'), '---\nverify: npm test\n---\n# Project\n');
    const found = trustSensitiveContent(root);
    expect(found).toEqual(['.autocode/hooks.json', '.mcp.json', 'AUTOCODE.md (verify: directive)']);
    expect(trustPrompt(root, found)).toContain('.mcp.json');
    rmSync(root, { recursive: true, force: true });
  });
});
