import { describe, it, expect } from 'vitest';
import { LineEditor, ANSWER_CANCELLED, type LineEditorCallbacks } from '../../src/repl/LineEditor.js';

function make(): { ed: LineEditor; cb: LineEditorCallbacks & { submits: string[]; interrupts: number; cycles: number } } {
  const submits: string[] = [];
  let interrupts = 0;
  let cycles = 0;
  const cb = {
    onChange: () => {},
    onSubmit: (t: string) => submits.push(t),
    onInterrupt: () => {
      interrupts += 1;
    },
    onCycleMode: () => {
      cycles += 1;
    },
    get submits() {
      return submits;
    },
    get interrupts() {
      return interrupts;
    },
    get cycles() {
      return cycles;
    },
  };
  return { ed: new LineEditor(cb), cb };
}

function type(ed: LineEditor, text: string): void {
  for (const ch of text) ed.feedKey(ch, { name: ch, sequence: ch });
}

describe('LineEditor', () => {
  it('inserts typed characters and tracks the cursor', () => {
    const { ed } = make();
    type(ed, 'hello');
    expect(ed.text).toBe('hello');
    expect(ed.cursorIndex).toBe(5);
  });

  it('backspace deletes before the cursor', () => {
    const { ed } = make();
    type(ed, 'hi');
    ed.feedKey(undefined, { name: 'backspace' });
    expect(ed.text).toBe('h');
  });

  it('left arrow then typing inserts mid-string', () => {
    const { ed } = make();
    type(ed, 'ac');
    ed.feedKey(undefined, { name: 'left' });
    type(ed, 'b');
    expect(ed.text).toBe('abc');
  });

  it('home and end move the cursor to the edges', () => {
    const { ed } = make();
    type(ed, 'word');
    ed.feedKey(undefined, { name: 'home' });
    expect(ed.cursorIndex).toBe(0);
    ed.feedKey(undefined, { name: 'end' });
    expect(ed.cursorIndex).toBe(4);
  });

  it('Ctrl+U clears the line', () => {
    const { ed } = make();
    type(ed, 'discard me');
    ed.feedKey(undefined, { name: 'u', ctrl: true });
    expect(ed.text).toBe('');
  });

  it('Enter submits the text and clears the buffer', () => {
    const { ed, cb } = make();
    type(ed, 'do the thing');
    ed.feedKey(undefined, { name: 'return' });
    expect(cb.submits).toEqual(['do the thing']);
    expect(ed.text).toBe('');
  });

  it('Enter on blank input does not submit', () => {
    const { ed, cb } = make();
    type(ed, '   ');
    ed.feedKey(undefined, { name: 'return' });
    expect(cb.submits).toHaveLength(0);
  });

  it('Ctrl+C fires onInterrupt', () => {
    const { ed, cb } = make();
    ed.feedKey(undefined, { name: 'c', ctrl: true });
    expect(cb.interrupts).toBe(1);
  });

  it('Shift+Tab fires onCycleMode', () => {
    const { ed, cb } = make();
    ed.feedKey(undefined, { name: 'tab', shift: true });
    expect(cb.cycles).toBe(1);
  });

  it('collapses pasted newlines to spaces', () => {
    const { ed } = make();
    ed.feedKey('line one\nline two', { name: undefined });
    expect(ed.text).toBe('line one line two');
  });

  it('askOnce captures an answer and restores the prior input', async () => {
    const { ed } = make();
    type(ed, 'main prompt');
    const answer = ed.askOnce();
    type(ed, 'yes');
    ed.feedKey(undefined, { name: 'return' });
    expect(await answer).toBe('yes');
    expect(ed.text).toBe('main prompt'); // restored
  });

  it('askOnce resolves with ANSWER_CANCELLED on Ctrl+C and interrupts the turn', async () => {
    const { ed, cb } = make();
    const answer = ed.askOnce();
    ed.feedKey(undefined, { name: 'c', ctrl: true });
    expect(await answer).toBe(ANSWER_CANCELLED);
    expect(cb.interrupts).toBe(1);
  });

  it('Shift+Tab does not cycle the mode while answering', async () => {
    const { ed, cb } = make();
    const answer = ed.askOnce();
    ed.feedKey(undefined, { name: 'tab', shift: true });
    ed.feedKey(undefined, { name: 'return' });
    await answer;
    expect(cb.cycles).toBe(0);
  });

  it('chooseOnce: arrows move the highlight, Enter resolves a single pick', async () => {
    const { ed } = make();
    const choice = ed.chooseOnce(['one', 'two', 'three'], false);
    ed.feedKey(undefined, { name: 'down' });
    ed.feedKey(undefined, { name: 'down' });
    ed.feedKey(undefined, { name: 'up' });
    expect(ed.choiceState?.highlight).toBe(1);
    ed.feedKey(undefined, { name: 'return' });
    expect(await choice).toEqual([1]);
    expect(ed.choosing).toBe(false);
  });

  it('chooseOnce multi: space toggles checkboxes, Enter submits the set', async () => {
    const { ed } = make();
    const choice = ed.chooseOnce(['a', 'b', 'c'], true);
    ed.feedKey(' ', { name: 'space' }); // check option 0
    ed.feedKey(undefined, { name: 'down' });
    ed.feedKey(undefined, { name: 'down' });
    ed.feedKey(' ', { name: 'space' }); // check option 2
    ed.feedKey(undefined, { name: 'return' });
    expect(await choice).toEqual([0, 2]);
  });

  it('chooseOnce: a letter key jumps to and picks an option (single)', async () => {
    const { ed } = make();
    const choice = ed.chooseOnce(['a', 'b', 'c'], false);
    ed.feedKey('c', { name: 'c', sequence: 'c' });
    expect(await choice).toEqual([2]);
  });

  it('chooseOnce: Ctrl+C resolves empty, restores input, and interrupts the turn', async () => {
    const { ed, cb } = make();
    type(ed, 'kept');
    const choice = ed.chooseOnce(['a', 'b'], false);
    ed.feedKey(undefined, { name: 'c', ctrl: true });
    expect(await choice).toEqual([]);
    expect(ed.text).toBe('kept');
    expect(cb.interrupts).toBe(1);
  });
});
