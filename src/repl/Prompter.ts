import { createInterface } from 'node:readline';
import { type EventEmitter, NullEventEmitter } from './EventEmitter.js';

// One interactive-input authority. Every yes/no confirm and free-text
// question goes through a Prompter. In Bridge mode we use AutoAcceptPrompter
// (inline approval cards are a follow-up); in non-TTY contexts (V6,
// --automax, CI) we use AutoDenyPrompter (auto-decline) or PlainPrompter
// (readline). The TuiPrompter that drove the legacy pinned-bar TUI was
// removed when that TUI was retired.
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
  const t = answer.trim().toLowerCase();
  return t === '' || t === 'y' || t === 'yes';
}

// Bridge (Ink TUI) interim prompter — auto-accepts all approvals so the
// agent doesn't hang on `default` mode while we wait for proper inline
// confirmation UI in the React tree. Effectively makes Bridge behave like
// `autocode` mode regardless of the selected mode. Tracked as a known
// limitation; Ink-side approval cards land in the next PR.
export class AutoAcceptPrompter implements Prompter {
  constructor(private readonly emitter: EventEmitter = new NullEventEmitter()) {}
  async confirm(message: string): Promise<boolean> {
    this.emitter.emit('picker_opened', { kind: 'confirm', message, options: ['Yes', 'No'] });
    this.emitter.emit('picker_resolved', { choice: 'yes' });
    return true;
  }
  async ask(message: string): Promise<string> {
    this.emitter.emit('text_input_opened', { prompt: message });
    this.emitter.emit('text_input_resolved', { answer: '' });
    return '';
  }
  async choose(question: string, options: string[], multiSelect: boolean): Promise<number[]> {
    this.emitter.emit('picker_opened', { kind: 'choose', question, options, multiSelect });
    const picked = options.length > 0 ? [0] : [];
    this.emitter.emit('picker_resolved', { choice: picked });
    return picked;
  }
  async approve(label: string): Promise<ApproveVerdict> {
    this.emitter.emit('picker_opened', { kind: 'approve', label, options: ['Accept', 'Decline', 'Revise'] });
    this.emitter.emit('picker_resolved', { choice: 'accept' });
    return { decision: 'accept' };
  }
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

// A swappable holder — lets AgentLoop be wired with a Prompter before the
// concrete TTY-aware prompter (PlainPrompter / AutoAcceptPrompter) exists.
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
