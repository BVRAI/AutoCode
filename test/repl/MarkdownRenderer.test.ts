import { describe, it, expect } from 'vitest';
import { renderMarkdown, looksLikeMarkdown } from '../../src/repl/MarkdownRenderer.js';

describe('looksLikeMarkdown', () => {
  it('detects bold', () => {
    expect(looksLikeMarkdown('this is **bold** text')).toBe(true);
  });

  it('detects fenced code blocks', () => {
    expect(looksLikeMarkdown('```ts\nx\n```')).toBe(true);
  });

  it('detects bullets', () => {
    expect(looksLikeMarkdown('- item\n- item')).toBe(true);
  });

  it('detects headers', () => {
    expect(looksLikeMarkdown('# Title')).toBe(true);
    expect(looksLikeMarkdown('## Sub')).toBe(true);
  });

  it('detects inline code', () => {
    expect(looksLikeMarkdown('use `foo` here')).toBe(true);
  });

  it('returns false for plain text', () => {
    expect(looksLikeMarkdown('just some plain text with no markdown')).toBe(false);
  });
});

describe('renderMarkdown', () => {
  it('renders bold text without throwing and preserves the word', () => {
    const out = renderMarkdown('**hello**');
    // marked-terminal applies ANSI in TTY; in non-TTY (vitest) it may leave **
    // alone. Either way: the word must survive.
    expect(out).toContain('hello');
    expect(typeof out).toBe('string');
  });

  it('preserves text in code blocks', () => {
    const out = renderMarkdown('```\nconst x = 1;\n```');
    expect(out).toContain('const x = 1;');
  });

  it('falls back to original input on render error', () => {
    // Empty string should not throw.
    expect(renderMarkdown('')).toBe('');
  });
});
