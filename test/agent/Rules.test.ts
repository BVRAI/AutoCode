import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { alwaysOnRules, discoverRules, globMatches, parsePathList, rulesForPath } from '../../src/agent/Rules.js';
import { resolveImports } from '../../src/agent/ProjectInstructions.js';

describe('path-scoped rules', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'autocode-rules-'));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('discovers rules from .autocode/rules and .claude/rules with paths frontmatter', () => {
    mkdirSync(join(root, '.autocode', 'rules'), { recursive: true });
    mkdirSync(join(root, '.claude', 'rules'), { recursive: true });
    writeFileSync(join(root, '.autocode', 'rules', 'api.md'), '---\npaths: ["src/api/**", "src/server/*.ts"]\n---\nAPI handlers validate input with zod.\n');
    writeFileSync(join(root, '.claude', 'rules', 'general.md'), 'Always write tests.\n');
    writeFileSync(join(root, '.claude', 'rules', 'ui.md'), '---\nglobs: src/ui/**\n---\nUse the design tokens.\n');
    const rules = discoverRules(root);
    expect(rules.map((r) => r.name)).toEqual(['api', 'general', 'ui']);
    expect(alwaysOnRules(rules).map((r) => r.name)).toEqual(['general']);
    expect(rulesForPath(rules, 'src/api/users/route.ts').map((r) => r.name)).toEqual(['api']);
    expect(rulesForPath(rules, 'src/server/app.ts').map((r) => r.name)).toEqual(['api']);
    expect(rulesForPath(rules, 'src/ui/Button.tsx').map((r) => r.name)).toEqual(['ui']);
    expect(rulesForPath(rules, 'README.md')).toEqual([]);
  });

  it('glob matching covers ** * and ?', () => {
    expect(globMatches('src/**', 'src/a/b/c.ts')).toBe(true);
    expect(globMatches('src/**/*.ts', 'src/c.ts')).toBe(true);
    expect(globMatches('src/*.ts', 'src/a/c.ts')).toBe(false);
    expect(globMatches('**/*.test.ts', 'x/y/z.test.ts')).toBe(true);
    expect(globMatches('src/?.ts', 'src/a.ts')).toBe(true);
    expect(parsePathList("['a/**', \"b/*.md\"]")).toEqual(['a/**', 'b/*.md']);
  });

  it('instruction files import other files with @path lines', () => {
    writeFileSync(join(root, 'STYLE.md'), '# Style\nTabs.\n');
    const inst = join(root, 'AGENTS.md');
    writeFileSync(inst, 'Read the style guide:\n@STYLE.md\n@missing.md\nDone.\n');
    const out = resolveImports('Read the style guide:\n@STYLE.md\n@missing.md\nDone.\n', inst);
    expect(out).toContain('<imported from="STYLE.md">\n# Style\nTabs.\n</imported>');
    expect(out).toContain('@missing.md');
  });
});
