import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildAgentInput, findMentions, MAX_TEXT_LINES } from '../../src/util/attachments.js';

function project(): string {
  const root = mkdtempSync(join(tmpdir(), 'attach-'));
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'src', 'app.ts'), 'const a = 1;\nexport default a;\n');
  writeFileSync(join(root, 'src', 'util.ts'), 'export const u = 2;\n');
  writeFileSync(join(root, 'shot.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  writeFileSync(join(root, 'spec.pdf'), Buffer.from('%PDF-1.4 fake'));
  writeFileSync(join(root, 'blob.bin'), Buffer.from([0x00, 0x01, 0x02]));
  writeFileSync(join(root, 'big.txt'), Array.from({ length: MAX_TEXT_LINES + 50 }, (_, i) => `line ${i}`).join('\n'));
  return root;
}

describe('findMentions', () => {
  it('finds @path tokens and drops trailing punctuation', () => {
    expect(findMentions('look at @src/app.ts, then @src/util.ts.')).toEqual(['src/app.ts', 'src/util.ts']);
    expect(findMentions('(see @docs/)')).toEqual(['docs/']);
    expect(findMentions('email me@example.com')).toEqual([]);
    expect(findMentions('@a @a')).toEqual(['a']);
  });
});

describe('buildAgentInput', () => {
  it('inlines text files after the prompt and keeps the mention in the text', () => {
    const root = project();
    const r = buildAgentInput('explain @src/app.ts please', root);
    expect(typeof r.input).toBe('string');
    const text = r.input as string;
    expect(text.startsWith('explain @src/app.ts please\n\n<file path="src/app.ts">\nconst a = 1;')).toBe(true);
    expect(text.endsWith('</file>')).toBe(true);
    expect(r.missing).toEqual([]);
  });

  it('lists a directory one level deep', () => {
    const root = project();
    const text = buildAgentInput('what is in @src/', root).input as string;
    expect(text).toContain('<directory path="src">\napp.ts\nutil.ts\n</directory>');
  });

  it('attaches images as blocks and PDFs as documents on providers that take them', () => {
    const root = project();
    const r = buildAgentInput('see @shot.png and @spec.pdf', root, { provider: 'anthropic' });
    expect(Array.isArray(r.input)).toBe(true);
    const blocks = r.input as Array<{ type: string; mediaType?: string; name?: string }>;
    expect(blocks[0]).toMatchObject({ type: 'text' });
    expect(blocks[1]).toMatchObject({ type: 'image', mediaType: 'image/png' });
    expect(blocks[2]).toMatchObject({ type: 'document', mediaType: 'application/pdf', name: 'spec.pdf' });
    expect(r.notes.some((n) => n.includes('1 image attached'))).toBe(true);
  });

  it('skips PDFs on providers without a document part, with a note', () => {
    const root = project();
    const r = buildAgentInput('read @spec.pdf', root, { provider: 'xai' });
    expect(typeof r.input).toBe('string');
    expect(r.notes[0]).toMatch(/PDF attachments are not supported on xai/);
  });

  it('skips binary files and truncates long text with a note', () => {
    const root = project();
    const r = buildAgentInput('@blob.bin @big.txt', root);
    const text = r.input as string;
    expect(r.notes.some((n) => n.includes('binary file, skipped'))).toBe(true);
    expect(r.notes.some((n) => n.includes('truncated'))).toBe(true);
    expect(text).toContain('… (truncated)');
    expect(text).not.toContain(`line ${MAX_TEXT_LINES + 10}`);
  });

  it('reports mentions that do not exist', () => {
    const root = project();
    const r = buildAgentInput('open @nope.ts', root);
    expect(r.input).toBe('open @nope.ts');
    expect(r.missing).toEqual(['nope.ts']);
  });
});
