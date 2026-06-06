import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSystemPrompt } from '../../src/agent/PromptBuilder.js';
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
  });
});
