import { createInterface } from 'node:readline';
import { ANSWER_CANCELLED, type LineEditor } from './LineEditor.js';
import type { ConsoleRenderer } from './ConsoleRenderer.js';
import type { Screen } from './Screen.js';

// One interactive-input authority. Every yes/no confirm and free-text
// question goes through a Prompter so the LineEditor stays the sole owner of
// stdin in the TUI (no nested readline fighting it).
export interface Prompter {
  confirm(message: string): Promise<boolean>;
  ask(message: string): Promise<string>;
  // Present a multiple-choice question; resolves with the selected option
  // indices ([] on cancel / no selection).
  choose(question: string, options: string[], multiSelect: boolean): Promise<number[]>;
}

export function parseYes(answer: string): boolean {
  if (answer === ANSWER_CANCELLED) return false;
  const t = answer.trim().toLowerCase();
  return t === '' || t === 'y' || t === 'yes';
}

// Headless: no interactive user — decline confirms, return empty answers.
export class AutoDenyPrompter implements Prompter {
  async confirm(): Promise<boolean> {
    return false;
  }
  async ask(): Promise<string> {
    return '';
  }
  async choose(): Promise<number[]> {
    return [];
  }
}

// Parse a comma/space-separated list of 1-based option numbers into indices.
function parseChoiceList(answer: string, count: number): number[] {
  const out: number[] = [];
  for (const tok of answer.split(/[\s,]+/)) {
    const n = Number.parseInt(tok, 10);
    if (Number.isInteger(n) && n >= 1 && n <= count && !out.includes(n - 1)) out.push(n - 1);
  }
  return out;
}

// Non-TTY interactive fallback: a one-shot readline question.
export class PlainPrompter implements Prompter {
  async confirm(message: string): Promise<boolean> {
    return parseYes(await this.ask(`${message} [Y/n] `));
  }
  ask(message: string): Promise<string> {
    return new Promise((resolve) => {
      const rl = createInterface({ input: process.stdin, output: process.stderr });
      rl.question(message, (a) => {
        rl.close();
        resolve(a.trim());
      });
    });
  }
  async choose(question: string, options: string[], multiSelect: boolean): Promise<number[]> {
    const list = options.map((o, i) => `  ${i + 1}) ${o}`).join('\n');
    const ans = await this.ask(
      `${question}\n${list}\n${multiSelect ? 'numbers (comma-separated): ' : 'number: '}`,
    );
    return parseChoiceList(ans, options.length).slice(0, multiSelect ? options.length : 1);
  }
}

// TUI: print the question into the output region, then borrow the LineEditor
// for the answer so the pinned bar handles the keystrokes. The output cursor
// is saved across the answer (the cursor visits the input box) and restored
// so streaming output resumes in the right place.
export class TuiPrompter implements Prompter {
  constructor(
    private readonly editor: LineEditor,
    private readonly renderer: ConsoleRenderer,
    private readonly screen: Screen,
  ) {}

  async confirm(message: string): Promise<boolean> {
    return parseYes(await this.askRaw(`${message} [Y/n]`));
  }

  async ask(message: string): Promise<string> {
    const a = await this.askRaw(message);
    return a === ANSWER_CANCELLED ? '' : a;
  }

  async choose(question: string, options: string[], multiSelect: boolean): Promise<number[]> {
    this.renderer.info(question);
    try {
      return await this.editor.chooseOnce(options, multiSelect);
    } finally {
      this.screen.moveToOutputBottom();
    }
  }

  private async askRaw(message: string): Promise<string> {
    this.renderer.info(message);
    try {
      return await this.editor.askOnce();
    } finally {
      // Resume output at the bottom of the output region.
      this.screen.moveToOutputBottom();
    }
  }
}

// A swappable holder — lets AgentLoop be wired with a Prompter before the
// LineEditor (and therefore the TuiPrompter) exists.
export class PrompterRef implements Prompter {
  private impl: Prompter;
  constructor(initial: Prompter) {
    this.impl = initial;
  }
  use(p: Prompter): void {
    this.impl = p;
  }
  confirm(message: string): Promise<boolean> {
    return this.impl.confirm(message);
  }
  ask(message: string): Promise<string> {
    return this.impl.ask(message);
  }
  choose(question: string, options: string[], multiSelect: boolean): Promise<number[]> {
    return this.impl.choose(question, options, multiSelect);
  }
}
