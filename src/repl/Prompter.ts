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

  private async askRaw(message: string): Promise<string> {
    this.renderer.info(message);
    this.screen.saveOutputCursor();
    try {
      return await this.editor.askOnce();
    } finally {
      this.screen.restoreOutputCursor();
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
}
