import { describe, it, expect } from 'vitest';
import {
  completeMention,
  countLines,
  cursorToRowCol,
  expandPastes,
  imageRefs,
  insertAt,
  isShortPaste,
  makePastePlaceholder,
  mentionTokenAt,
} from '../../src/repl/ink/composerText.js';

describe('paste placeholders', () => {
  it('collapse long pastes and expand them back on submit', () => {
    const text = Array.from({ length: 12 }, (_, i) => `line ${i}`).join('\n');
    expect(isShortPaste(text)).toBe(false);
    const ph = makePastePlaceholder(1, text);
    expect(ph).toBe('[Pasted text #1 +12 lines]');
    const pastes = new Map([[1, text]]);
    expect(expandPastes(`fix this ${ph} please`, pastes)).toBe(`fix this ${text} please`);
    expect(expandPastes('[Pasted text #9 +3 lines]', pastes)).toBe('[Pasted text #9 +3 lines]');
  });

  it('keeps short pastes inline', () => {
    expect(isShortPaste('a\nb\nc')).toBe(true);
    expect(isShortPaste('x'.repeat(401))).toBe(false);
    expect(countLines('a\nb\n')).toBe(2);
    expect(countLines('')).toBe(0);
  });

  it('lists image placeholders in order', () => {
    expect(imageRefs('see [Image #2] and [Image #1]')).toEqual([2, 1]);
  });
});

describe('cursor mapping', () => {
  it('maps offsets to rows and columns across newlines', () => {
    expect(cursorToRowCol('ab\ncd', 0)).toEqual({ row: 0, col: 0 });
    expect(cursorToRowCol('ab\ncd', 2)).toEqual({ row: 0, col: 2 });
    expect(cursorToRowCol('ab\ncd', 3)).toEqual({ row: 1, col: 0 });
    expect(cursorToRowCol('ab\ncd', 5)).toEqual({ row: 1, col: 2 });
    expect(cursorToRowCol('ab\ncd', 99)).toEqual({ row: 1, col: 2 });
  });

  it('insertAt advances the cursor past the piece', () => {
    expect(insertAt('ac', 1, 'b')).toEqual({ text: 'abc', cursor: 2 });
  });
});

describe('@ mentions', () => {
  it('finds the token under the cursor and completes it', () => {
    expect(mentionTokenAt('look at @src/ap', 15)).toEqual({ start: 8, query: 'src/ap' });
    expect(mentionTokenAt('look at @', 9)).toEqual({ start: 8, query: '' });
    expect(mentionTokenAt('mail me@x.com', 13)).toBeNull();
    expect(mentionTokenAt('look at @src/ap tail', 15)).toEqual({ start: 8, query: 'src/ap' });
    expect(completeMention('look at @src/ap tail', 15, 'src/app.ts')).toEqual({
      text: 'look at @src/app.ts  tail',
      cursor: 20,
    });
  });
});
