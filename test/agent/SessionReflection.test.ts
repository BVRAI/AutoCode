import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  applyProposal,
  buildReflectionPrompt,
  parseProposals,
  resolveTarget,
  runSessionReflection,
  type Proposal,
  type SessionSnapshot,
} from '../../src/agent/SessionReflection.js';

describe('parseProposals', () => {
  it('parses a clean JSON array', () => {
    const text = `[
      {"text": "use kebab-case for filenames", "scope": "", "reason": "consistency with the rest of the project"},
      {"text": "tests live in tests/agent/", "scope": "src/agent", "reason": "we keep tests per-subsystem"}
    ]`;
    const r = parseProposals(text);
    expect(r).toHaveLength(2);
    expect(r[0]!.scope).toBe('');
    expect(r[1]!.scope).toBe('src/agent');
  });

  it('parses JSON wrapped in a markdown code fence', () => {
    const text = '```json\n[{"text":"x","scope":"","reason":"y"}]\n```';
    const r = parseProposals(text);
    expect(r).toHaveLength(1);
    expect(r[0]!.text).toBe('x');
  });

  it('parses an array surrounded by prose', () => {
    const text = 'Here are my proposals:\n[{"text":"x","scope":"","reason":"y"}]\nThat is all.';
    const r = parseProposals(text);
    expect(r).toHaveLength(1);
  });

  it('returns [] on malformed JSON', () => {
    expect(parseProposals('not json')).toEqual([]);
    expect(parseProposals('[{broken')).toEqual([]);
    expect(parseProposals('')).toEqual([]);
  });

  it('skips entries with empty text', () => {
    const text = '[{"text":"","scope":"","reason":"r"},{"text":"keep","scope":"","reason":"r"}]';
    const r = parseProposals(text);
    expect(r).toHaveLength(1);
    expect(r[0]!.text).toBe('keep');
  });

  it('truncates very long text', () => {
    const longText = 'x'.repeat(800);
    const r = parseProposals(`[{"text":"${longText}","scope":"","reason":"r"}]`);
    expect(r[0]!.text.length).toBeLessThanOrEqual(400);
  });

  it('normalizes scope — strips ./ and trailing slash, rejects parent traversal', () => {
    const r = parseProposals(`[
      {"text":"a","scope":"./src/api/","reason":"r"},
      {"text":"b","scope":"../etc","reason":"r"},
      {"text":"c","scope":"..","reason":"r"},
      {"text":"d","scope":"src\\\\agent","reason":"r"}
    ]`);
    expect(r.map((p) => p.scope)).toEqual(['src/api', '', '', 'src/agent']);
  });

  it('caps at 5 proposals', () => {
    const items = Array.from({ length: 10 }, (_, i) => `{"text":"t${i}","scope":"","reason":"r"}`).join(',');
    const r = parseProposals(`[${items}]`);
    expect(r).toHaveLength(5);
  });
});

describe('resolveTarget', () => {
  it('points to root AUTOCODE.md when scope is empty', () => {
    const t = resolveTarget({ text: 'x', scope: '', reason: '' }, '/proj');
    expect(t.replace(/\\/g, '/')).toBe('/proj/AUTOCODE.md');
  });

  it('points to subtree AUTOCODE.md when scope is set', () => {
    const t = resolveTarget({ text: 'x', scope: 'src/api', reason: '' }, '/proj');
    expect(t.replace(/\\/g, '/')).toBe('/proj/src/api/AUTOCODE.md');
  });
});

describe('applyProposal', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'autocode-reflect-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('appends to an existing AUTOCODE.md preserving prior content', () => {
    const target = join(dir, 'AUTOCODE.md');
    writeFileSync(target, '# AUTOCODE.md\n\nExisting line.\n');
    const p: Proposal = { text: 'new convention', scope: '', reason: 'r', target };
    applyProposal(p);
    const content = readFileSync(target, 'utf8');
    expect(content).toContain('Existing line.');
    expect(content).toContain('new convention');
    expect(content).toMatch(/## \(added by autocode on \d{4}-\d{2}-\d{2}\)/);
  });

  it('creates a fresh AUTOCODE.md with a header when the file does not exist', () => {
    const target = join(dir, 'AUTOCODE.md');
    expect(existsSync(target)).toBe(false);
    applyProposal({ text: 'first rule', scope: '', reason: 'r', target });
    const content = readFileSync(target, 'utf8');
    expect(content).toMatch(/^# AUTOCODE\.md/);
    expect(content).toContain('first rule');
  });

  it('creates intermediate directories for a subtree-scoped target', () => {
    const target = join(dir, 'src', 'deep', 'subdir', 'AUTOCODE.md');
    applyProposal({ text: 'narrow rule', scope: 'src/deep/subdir', reason: 'r', target });
    expect(existsSync(target)).toBe(true);
    expect(readFileSync(target, 'utf8')).toContain('narrow rule');
  });

  it('two applications append, never overwrite', () => {
    const target = join(dir, 'AUTOCODE.md');
    applyProposal({ text: 'first', scope: '', reason: 'r', target });
    applyProposal({ text: 'second', scope: '', reason: 'r', target });
    const content = readFileSync(target, 'utf8');
    expect(content).toContain('first');
    expect(content).toContain('second');
  });
});

describe('buildReflectionPrompt', () => {
  it('includes user prompts, files changed, and tool calls', () => {
    const snap: SessionSnapshot = {
      userPrompts: ['fix the bug in foo'],
      assistantReplies: ['done — foo.ts updated'],
      toolCalls: [{ name: 'edit_file', argsPreview: '{"path":"foo.ts"}' }],
      filesChanged: ['foo.ts'],
    };
    const p = buildReflectionPrompt(snap);
    expect(p).toContain('fix the bug in foo');
    expect(p).toContain('foo.ts');
    expect(p).toContain('edit_file');
  });
});

describe('runSessionReflection', () => {
  const fakeProjectRoot = '/proj';

  function makeRouter(responseText: string): {
    complete: (...args: unknown[]) => Promise<{ content: Array<{ type: 'text'; text: string }>; usage: { inputTokens: number; outputTokens: number } }>;
  } {
    return {
      complete: async () => ({
        content: [{ type: 'text' as const, text: responseText }],
        usage: { inputTokens: 1, outputTokens: 1 },
      }),
    };
  }

  function makeErrorRouter(): { complete: (...args: unknown[]) => Promise<never> } {
    return {
      complete: async () => {
        throw new Error('network');
      },
    };
  }

  it('returns [] for a trivial session (no files, few tool calls)', async () => {
    const r = await runSessionReflection(
      { userPrompts: ['hi'], assistantReplies: ['hi'], toolCalls: [], filesChanged: [] },
      // biome-ignore: any
      { router: makeRouter('[]') as never, provider: 'xai' as never, model: 'm', projectRoot: fakeProjectRoot },
    );
    expect(r).toEqual([]);
  });

  it('returns [] on LLM error (silent failure — never throws)', async () => {
    const r = await runSessionReflection(
      {
        userPrompts: ['p'],
        assistantReplies: ['r'],
        toolCalls: [],
        filesChanged: ['a.ts', 'b.ts'],
      },
      // biome-ignore: any
      { router: makeErrorRouter() as never, provider: 'xai' as never, model: 'm', projectRoot: fakeProjectRoot },
    );
    expect(r).toEqual([]);
  });

  it('resolves each proposal to a project-rooted target path', async () => {
    const response = '[{"text":"x","scope":"","reason":"r"},{"text":"y","scope":"src/api","reason":"r"}]';
    const r = await runSessionReflection(
      {
        userPrompts: ['p'],
        assistantReplies: ['r'],
        toolCalls: [],
        filesChanged: ['foo.ts'],
      },
      // biome-ignore: any
      { router: makeRouter(response) as never, provider: 'xai' as never, model: 'm', projectRoot: fakeProjectRoot },
    );
    expect(r).toHaveLength(2);
    expect(r[0]!.target.replace(/\\/g, '/')).toBe('/proj/AUTOCODE.md');
    expect(r[1]!.target.replace(/\\/g, '/')).toBe('/proj/src/api/AUTOCODE.md');
  });
});
