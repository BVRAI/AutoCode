// Pure helpers behind the composer: paste placeholders, image placeholders,
// the `@` mention token under the cursor, and cursor ↔ row/column mapping for
// the multi-line input. No Ink here, so all of it is unit-testable.

/** What the composer hands the host along with the expanded prompt text. */
export interface SubmitExtras {
  /** What the transcript shows for this turn (placeholders instead of pasted text). */
  display?: string;
  /** Clipboard images to attach, as temp files. */
  images?: Array<{ path: string; mediaType: string }>;
}

/** Pastes longer than this collapse to a placeholder (Claude Code's rule of thumb). */
export const PASTE_INLINE_MAX_LINES = 5;
export const PASTE_INLINE_MAX_CHARS = 400;

const PASTE_RE = /\[Pasted text #(\d+) \+\d+ lines\]/g;
const IMAGE_RE = /\[Image #(\d+)\]/g;

export function makePastePlaceholder(n: number, text: string): string {
  return `[Pasted text #${n} +${countLines(text)} lines]`;
}

export function makeImagePlaceholder(n: number): string {
  return `[Image #${n}]`;
}

export function countLines(text: string): number {
  const t = text.replace(/\r/g, '');
  if (t.length === 0) return 0;
  return t.replace(/\n$/, '').split('\n').length;
}

/** Whether a paste is short enough to drop into the input as-is. */
export function isShortPaste(text: string): boolean {
  return countLines(text) <= PASTE_INLINE_MAX_LINES && text.length <= PASTE_INLINE_MAX_CHARS;
}

/** Replace paste placeholders with their stored text; unknown ones stay as typed. */
export function expandPastes(text: string, pastes: ReadonlyMap<number, string>): string {
  return text.replace(PASTE_RE, (whole, n: string) => pastes.get(Number(n)) ?? whole);
}

/** The image numbers referenced by placeholders, in order of appearance. */
export function imageRefs(text: string): number[] {
  const out: number[] = [];
  for (const m of text.matchAll(IMAGE_RE)) out.push(Number(m[1]));
  return out;
}

/** Cursor offset → { row, col } in the line-split input. */
export function cursorToRowCol(text: string, cursor: number): { row: number; col: number } {
  const lines = text.split('\n');
  let remaining = Math.max(0, Math.min(cursor, text.length));
  for (let row = 0; row < lines.length; row++) {
    const len = lines[row]!.length;
    if (remaining <= len) return { row, col: remaining };
    remaining -= len + 1;
  }
  return { row: lines.length - 1, col: lines[lines.length - 1]!.length };
}

/**
 * The `@` mention being typed at the cursor: `{ start, query }` where `start`
 * is the offset of the `@` and `query` the text after it, or null when the
 * cursor is not inside such a token.
 */
export function mentionTokenAt(text: string, cursor: number): { start: number; query: string } | null {
  const before = text.slice(0, cursor);
  const m = /(?:^|[\s(])@([^\s@]*)$/.exec(before);
  if (!m) return null;
  const start = before.length - m[1]!.length - 1;
  return { start, query: m[1]! };
}

/** Replace the mention token at the cursor with `@path ` and return the new text + cursor. */
export function completeMention(text: string, cursor: number, path: string): { text: string; cursor: number } {
  const tok = mentionTokenAt(text, cursor);
  if (!tok) return { text, cursor };
  const insert = `@${path} `;
  const next = text.slice(0, tok.start) + insert + text.slice(cursor);
  return { text: next, cursor: tok.start + insert.length };
}

/** Insert `piece` at the cursor. */
export function insertAt(text: string, cursor: number, piece: string): { text: string; cursor: number } {
  return { text: text.slice(0, cursor) + piece + text.slice(cursor), cursor: cursor + piece.length };
}
