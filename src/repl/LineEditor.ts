import { emitKeypressEvents } from 'node:readline';

// Parsed key event shape from Node's readline keypress emitter.
export interface KeyEvent {
  sequence?: string;
  name?: string;
  ctrl?: boolean;
  meta?: boolean;
  shift?: boolean;
}

export interface LineEditorCallbacks {
  onChange(): void; // buffer / cursor / choice moved — redraw the bar
  onSubmit(text: string): void;
  onInterrupt(): void; // Ctrl+C
  onCycleMode(): void; // Shift+Tab
}

// Resolved value when Ctrl+C is pressed during an answer prompt.
export const ANSWER_CANCELLED = '\x03';

export interface ChoiceState {
  options: string[];
  highlight: number;
  checked: Set<number>;
  multiSelect: boolean;
}

// A minimal raw-mode line editor — replaces Node's readline.Interface so the
// input can live in a pinned footer the terminal does not own. Besides plain
// line editing it supports two borrowed modes: `askOnce()` (one free-text
// answer) and `chooseOnce()` (a multiple-choice picker). Both save and
// restore the in-progress input.
export class LineEditor {
  private buffer = '';
  private cursor = 0;
  private started = false;
  private pending: { resolve: (s: string) => void; savedBuffer: string; savedCursor: number } | null = null;
  private choice:
    | (ChoiceState & { resolve: (n: number[]) => void; savedBuffer: string; savedCursor: number })
    | null = null;

  constructor(private readonly cb: LineEditorCallbacks) {}

  get text(): string {
    return this.buffer;
  }
  get cursorIndex(): number {
    return this.cursor;
  }
  get answering(): boolean {
    return this.pending !== null;
  }
  get choosing(): boolean {
    return this.choice !== null;
  }
  get choiceState(): ChoiceState | null {
    if (!this.choice) return null;
    return {
      options: this.choice.options,
      highlight: this.choice.highlight,
      checked: this.choice.checked,
      multiSelect: this.choice.multiSelect,
    };
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    emitKeypressEvents(process.stdin);
    if (process.stdin.isTTY) process.stdin.setRawMode(true);
    process.stdin.on('keypress', this.onKeypress);
    process.stdin.resume();
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;
    process.stdin.off('keypress', this.onKeypress);
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
  }

  clear(): void {
    this.buffer = '';
    this.cursor = 0;
  }

  // Borrow the editor for one free-text answer.
  askOnce(): Promise<string> {
    return new Promise<string>((resolve) => {
      this.pending = { resolve, savedBuffer: this.buffer, savedCursor: this.cursor };
      this.buffer = '';
      this.cursor = 0;
      this.cb.onChange();
    });
  }

  // Borrow the editor for one multiple-choice selection. Resolves with the
  // selected option indices ([] on cancel / no selection).
  chooseOnce(options: string[], multiSelect: boolean): Promise<number[]> {
    return new Promise<number[]>((resolve) => {
      this.choice = {
        resolve,
        savedBuffer: this.buffer,
        savedCursor: this.cursor,
        options: [...options],
        highlight: 0,
        checked: new Set<number>(),
        multiSelect,
      };
      this.cb.onChange();
    });
  }

  private onKeypress = (str: string | undefined, key: KeyEvent | undefined): void => {
    this.feedKey(str, key);
  };

  // Exposed for tests — apply one key event.
  feedKey(str: string | undefined, key: KeyEvent | undefined): void {
    if (this.choice) return this.feedChoiceKey(str, key);
    if (key) {
      if (key.ctrl && key.name === 'c') {
        if (this.pending) return this.resolveAnswer(ANSWER_CANCELLED);
        return this.cb.onInterrupt();
      }
      if (key.name === 'return' || key.name === 'enter') {
        if (this.pending) return this.resolveAnswer(this.buffer);
        return this.submit();
      }
      if (key.name === 'tab' && key.shift) {
        if (!this.pending) this.cb.onCycleMode();
        return;
      }
      if (key.name === 'backspace') return this.backspace();
      if (key.name === 'delete') return this.deleteForward();
      if (key.name === 'left') return this.move(-1);
      if (key.name === 'right') return this.move(1);
      if (key.name === 'home' || (key.ctrl && key.name === 'a')) return this.setCursor(0);
      if (key.name === 'end' || (key.ctrl && key.name === 'e')) return this.setCursor(this.buffer.length);
      if (key.ctrl && key.name === 'u') {
        this.clear();
        return this.cb.onChange();
      }
      if (key.ctrl || key.meta) return; // ignore other control chords
    }
    if (str) this.insert(str);
  }

  private feedChoiceKey(str: string | undefined, key: KeyEvent | undefined): void {
    const c = this.choice!;
    if (key) {
      if (key.ctrl && key.name === 'c') return this.resolveChoice([]);
      if (key.name === 'up') {
        c.highlight = Math.max(0, c.highlight - 1);
        return this.cb.onChange();
      }
      if (key.name === 'down') {
        c.highlight = Math.min(c.options.length - 1, c.highlight + 1);
        return this.cb.onChange();
      }
      if (key.name === 'return' || key.name === 'enter') {
        return this.resolveChoice(
          c.multiSelect ? [...c.checked].sort((a, b) => a - b) : [c.highlight],
        );
      }
      if (key.name === 'space') {
        if (c.multiSelect) {
          this.toggleChecked(c.highlight);
          this.cb.onChange();
        }
        return;
      }
      if (key.ctrl || key.meta) return;
    }
    // Digit / letter shortcut → jump to that option.
    if (str && str.length === 1) {
      const idx = optionIndexFromKey(str);
      if (idx >= 0 && idx < c.options.length) {
        if (c.multiSelect) {
          this.toggleChecked(idx);
          this.cb.onChange();
        } else {
          this.resolveChoice([idx]);
        }
      }
    }
  }

  private toggleChecked(i: number): void {
    const set = this.choice!.checked;
    if (set.has(i)) set.delete(i);
    else set.add(i);
  }

  private resolveChoice(indices: number[]): void {
    const c = this.choice;
    if (!c) return;
    this.choice = null;
    this.buffer = c.savedBuffer;
    this.cursor = c.savedCursor;
    this.cb.onChange();
    c.resolve(indices);
  }

  private resolveAnswer(value: string): void {
    const p = this.pending;
    if (!p) return;
    this.pending = null;
    this.buffer = p.savedBuffer;
    this.cursor = p.savedCursor;
    this.cb.onChange();
    p.resolve(value);
  }

  private insert(s: string): void {
    // Collapse newlines to spaces (v1 single-line) and drop control chars.
    let clean = '';
    for (const ch of s.replace(/[\r\n]+/g, ' ')) {
      const c = ch.codePointAt(0) ?? 0;
      if (c >= 0x20 && c !== 0x7f) clean += ch;
    }
    if (clean.length === 0) return;
    this.buffer = this.buffer.slice(0, this.cursor) + clean + this.buffer.slice(this.cursor);
    this.cursor += clean.length;
    this.cb.onChange();
  }

  private backspace(): void {
    if (this.cursor === 0) return;
    this.buffer = this.buffer.slice(0, this.cursor - 1) + this.buffer.slice(this.cursor);
    this.cursor -= 1;
    this.cb.onChange();
  }

  private deleteForward(): void {
    if (this.cursor >= this.buffer.length) return;
    this.buffer = this.buffer.slice(0, this.cursor) + this.buffer.slice(this.cursor + 1);
    this.cb.onChange();
  }

  private move(delta: number): void {
    this.setCursor(this.cursor + delta);
  }

  private setCursor(pos: number): void {
    this.cursor = Math.max(0, Math.min(this.buffer.length, pos));
    this.cb.onChange();
  }

  private submit(): void {
    const text = this.buffer;
    this.clear();
    if (text.trim().length === 0) {
      this.cb.onChange();
      return;
    }
    this.cb.onSubmit(text);
  }
}

// Map a digit (1-9) or letter (a-z) key to a 0-indexed option, else -1.
function optionIndexFromKey(ch: string): number {
  if (ch >= '1' && ch <= '9') return ch.charCodeAt(0) - '1'.charCodeAt(0);
  const lower = ch.toLowerCase();
  if (lower >= 'a' && lower <= 'z') return lower.charCodeAt(0) - 'a'.charCodeAt(0);
  return -1;
}
