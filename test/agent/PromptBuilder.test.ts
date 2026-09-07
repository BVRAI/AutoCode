import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSystemPrompt, userLanguageLine } from '../../src/agent/PromptBuilder.js';
import type { SessionContext } from '../../src/session/SessionContext.js';

function ctxFor(root: string): SessionContext {
  return {
    sessionId: 'test',
    projectRoot: root,
    dataDir: root,
    sessionDir: join(root, 's'),
    model: { provider: 'anthropic', model: 'claude-opus-4-7' },
    startedAt: new Date().toISOString(),
    mode: 'default',
  };
}

describe('PromptBuilder — large-codebase localization protocol gating', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'autocode-prompt-'));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  // The regression-safety contract: small / single-exercise repos (e.g. the
  // polyglot benchmark) must NOT receive the extra localization protocol, so
  // their prompt is unchanged.
  it('omits the protocol for a small project', () => {
    writeFileSync(join(root, 'a.ts'), 'export const a = 1;\n');
    writeFileSync(join(root, 'b.ts'), 'export const b = 2;\n');
    const prompt = buildSystemPrompt(ctxFor(root));
    expect(prompt).not.toContain('Navigating a large codebase');
  });

  it('includes the protocol once the repo is large', () => {
    for (let i = 0; i < 30; i++) {
      writeFileSync(join(root, `f${i}.ts`), `export const v${i} = ${i};\n`);
    }
    const prompt = buildSystemPrompt(ctxFor(root));
    expect(prompt).toContain('Navigating a large codebase');
    expect(prompt).toContain('find_symbol');
    expect(prompt).toContain('file_deps');
  });
});

describe('PromptBuilder — reproduce-first principle', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'autocode-prompt-'));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('always includes the reproduce-bugs-first working principle', () => {
    writeFileSync(join(root, 'a.ts'), 'export const a = 1;\n');
    const prompt = buildSystemPrompt(ctxFor(root));
    expect(prompt).toContain('Reproduce bugs before fixing them');
    expect(prompt).toContain('A fix without a reproduction is a guess');
  });
});

describe('PromptBuilder — user language (AUTOMAX_LOCALE)', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'autocode-prompt-'));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  // The regression-safety contract: English or no locale must leave the prompt
  // byte-identical, so benchmark runs never see a different prefix.
  it('adds nothing for English or no locale', () => {
    writeFileSync(join(root, 'a.ts'), 'export const a = 1;\n');
    const base = buildSystemPrompt(ctxFor(root));
    expect(base).not.toContain("User's language");
    expect(buildSystemPrompt({ ...ctxFor(root), locale: 'en' })).toBe(base);
    expect(buildSystemPrompt({ ...ctxFor(root), locale: 'en-US' })).toBe(base);
    expect(buildSystemPrompt({ ...ctxFor(root), locale: '  ' })).toBe(base);
  });

  it('asks for replies in the user language while keeping code untouched', () => {
    writeFileSync(join(root, 'a.ts'), 'export const a = 1;\n');
    const prompt = buildSystemPrompt({ ...ctxFor(root), locale: 'fr' });
    expect(prompt).toContain("User's language: French (fr)");
    expect(prompt).toContain('Keep code, identifiers, file paths, commands and tool arguments exactly as they are');
  });

  it('names region-tagged and unknown codes sensibly', () => {
    expect(userLanguageLine('zh-Hans')).toContain('Simplified Chinese (zh-Hans)');
    expect(userLanguageLine('pt-BR')).toContain('Brazilian Portuguese (pt-BR)');
    expect(userLanguageLine('fr-CA')).toContain('French (fr-CA)');
    expect(userLanguageLine('xx')).toContain('xx (xx)');
  });
});
