import { createInterface } from 'node:readline';
import { ANSWER_CANCELLED, type LineEditor } from './LineEditor.js';
import type { ConsoleRenderer } from './ConsoleRenderer.js';
import type { Screen } from './Screen.js';
import { type EventEmitter, NullEventEmitter } from './EventEmitter.js';

// One interactive-input authority. Every yes/no confirm and free-text
// question goes through a Prompter so the LineEditor stays the sole owner of
// stdin in the TUI (no nested readline fighting it).
// The outcome of an edit/command approval: apply it, skip it, or skip it
// with guidance the agent should use to revise its approach.
export type ApproveVerdict = { decision: 'accept' | 'decline' | 'revise'; guidance?: string };

const APPROVE_OPTIONS = ['Accept', 'Decline', 'Revise — give the agent more guidance'];

export interface Prompter {
  confirm(message: string): Promise<boolean>;
  ask(message: string): Promise<string>;
  // Present a multiple-choice question; resolves with the selected option
  // indices ([] on cancel / no selection).
  choose(question: string, options: string[], multiSelect: boolean): Promise<number[]>;
  // Present an action for approval — accept / decline / revise.
  approve(label: string): Promise<ApproveVerdict>;
}

export function parseYes(answer: string): boolean {
  if (answer === ANSWER_CANCELLED) return false;
  const t = answer.trim().toLowerCase();
  return t === '' || t === 'y' || t === 'yes';
}

// Headless: no interactive user — decline confirms, return empty answers.
// Still emits open/resolved events so the Automax host can see "autocode
// reached a gate it can't satisfy" rather than guessing.
export class AutoDenyPrompter implements Prompter {
  constructor(private readonly emitter: EventEmitter = new NullEventEmitter()) {}
  async confirm(message: string): Promise<boolean> {
    this.emitter.emit('picker_opened', { kind: 'confirm', message, options: ['Yes', 'No'] });
    this.emitter.emit('picker_resolved', { choice: 'no' });
    return false;
  }
  async ask(message: string): Promise<string> {
    this.emitter.emit('text_input_opened', { prompt: message });
    this.emitter.emit('text_input_resolved', { answer: '' });
    return '';
  }
  async choose(question: string, options: string[], multiSelect: boolean): Promise<number[]> {
    this.emitter.emit('picker_opened', { kind: 'choose', question, options, multiSelect });
    this.emitter.emit('picker_resolved', { choice: [] });
    return [];
  }
  async approve(label: string): Promise<ApproveVerdict> {
    this.emitter.emit('picker_opened', { kind: 'approve', label, options: ['Accept', 'Decline', 'Revise'] });
    this.emitter.emit('picker_resolved', { choice: 'decline' });
    return { decision: 'decline' };
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
  constructor(private readonly emitter: EventEmitter = new NullEventEmitter()) {}
  async confirm(message: string): Promise<boolean> {
    this.emitter.emit('picker_opened', { kind: 'confirm', message, options: ['Yes', 'No'] });
    const yes = parseYes(await this.askInternal(`${message} [Y/n] `));
    this.emitter.emit('picker_resolved', { choice: yes ? 'yes' : 'no' });
    return yes;
  }
  async ask(message: string): Promise<string> {
    this.emitter.emit('text_input_opened', { prompt: message });
    const a = await this.askInternal(message);
    this.emitter.emit('text_input_resolved', { answer: a });
    return a;
  }
  // Internal readline ask used by confirm/choose/approve so the picker-level
  // events aren't shadowed by a nested text_input pair.
  private askInternal(message: string): Promise<string> {
    return new Promise((resolve) => {
      const rl = createInterface({ input: process.stdin, output: process.stderr });
      rl.question(message, (a) => {
        rl.close();
        resolve(a.trim());
      });
    });
  }
  async choose(question: string, options: string[], multiSelect: boolean): Promise<number[]> {
    this.emitter.emit('picker_opened', { kind: 'choose', question, options, multiSelect });
    const list = options.map((o, i) => `  ${i + 1}) ${o}`).join('\n');
    const ans = await this.askInternal(
      `${question}\n${list}\n${multiSelect ? 'numbers (comma-separated): ' : 'number: '}`,
    );
    const choices = parseChoiceList(ans, options.length).slice(0, multiSelect ? options.length : 1);
    this.emitter.emit('picker_resolved', { choice: choices });
    return choices;
  }
  async approve(label: string): Promise<ApproveVerdict> {
    this.emitter.emit('picker_opened', { kind: 'approve', label, options: ['Accept', 'Decline', 'Revise'] });
    const list = APPROVE_OPTIONS.map((o, i) => `  ${i + 1}) ${o}`).join('\n');
    const ans = (await this.askInternal(`${label}\n${list}\nchoice: `)).trim();
    let decision: 'accept' | 'decline' | 'revise' = 'decline';
    if (ans === '1') decision = 'accept';
    else if (ans === '3') decision = 'revise';
    this.emitter.emit('picker_resolved', { choice: decision });
    if (decision === 'revise') return { decision, guidance: await this.ask('Guidance: ') };
    return { decision };
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
    private readonly emitter: EventEmitter = new NullEventEmitter(),
  ) {}

  async confirm(message: string): Promise<boolean> {
    this.emitter.emit('picker_opened', { kind: 'confirm', message, options: ['Yes', 'No'] });
    const yes = parseYes(await this.askRaw(`${message} [Y/n]`));
    this.emitter.emit('picker_resolved', { choice: yes ? 'yes' : 'no' });
    return yes;
  }

  async ask(message: string): Promise<string> {
    this.emitter.emit('text_input_opened', { prompt: message });
    const a = await this.askRaw(message);
    const answer = a === ANSWER_CANCELLED ? '' : a;
    this.emitter.emit('text_input_resolved', { answer });
    return answer;
  }

  async choose(question: string, options: string[], multiSelect: boolean): Promise<number[]> {
    this.emitter.emit('picker_opened', { kind: 'choose', question, options, multiSelect });
    this.renderer.info(question);
    let result: number[];
    try {
      result = await this.editor.chooseOnce(options, multiSelect);
    } finally {
      this.screen.moveToOutputBottom();
    }
    this.emitter.emit('picker_resolved', { choice: result });
    return result;
  }

  async approve(label: string): Promise<ApproveVerdict> {
    this.emitter.emit('picker_opened', { kind: 'approve', label, options: ['Accept', 'Decline', 'Revise'] });
    this.renderer.info(label);
    let picked: number[];
    try {
      picked = await this.editor.chooseOnce(APPROVE_OPTIONS, false);
    } finally {
      this.screen.moveToOutputBottom();
    }
    let decision: 'accept' | 'decline' | 'revise' = 'decline';
    if (picked[0] === 0) decision = 'accept';
    else if (picked[0] === 2) decision = 'revise';
    this.emitter.emit('picker_resolved', { choice: decision });
    if (decision === 'revise') {
      const g = await this.ask('Describe how to revise:');
      return { decision, guidance: g };
    }
    return { decision };
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
  approve(label: string): Promise<ApproveVerdict> {
    return this.impl.approve(label);
  }
}
