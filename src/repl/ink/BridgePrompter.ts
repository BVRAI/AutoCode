// The Bridge's real interactive prompter — replaces the interim
// AutoAcceptPrompter that silently approved everything (which made
// `default` mode behave like full-auto `autocode` mode in the primary UI).
//
// Each Prompter call pushes a PromptRequest overlay into the BridgeStore;
// PromptOverlay renders it and calls the embedded resolve, which closes the
// overlay and completes the promise. Requests are serialized through an
// internal queue so overlapping prompts (rare — tool calls are sequential)
// can't clobber each other's overlay.

import { type EventEmitter, NullEventEmitter } from '../EventEmitter.js';
import type { ApproveDetail, ApproveVerdict, Prompter } from '../Prompter.js';
import type { BridgeStore, PromptRequest } from './store.js';

export class BridgePrompter implements Prompter {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly store: BridgeStore,
    private readonly emitter: EventEmitter = new NullEventEmitter(),
  ) {}

  // Serialize overlay usage: each request waits for the previous one to
  // resolve before claiming the overlay slot.
  private enqueue<T>(open: (done: (value: T) => void) => PromptRequest): Promise<T> {
    const run = this.queue.then(
      () =>
        new Promise<T>((resolvePromise) => {
          const request = open((value: T) => {
            this.store.setOverlay(null);
            resolvePromise(value);
          });
          this.store.setOverlay({ kind: 'prompt', request });
        }),
    );
    // Chain regardless of outcome so one failure can't wedge the queue.
    this.queue = run.catch(() => undefined);
    return run;
  }

  async confirm(message: string): Promise<boolean> {
    this.emitter.emit('picker_opened', { kind: 'confirm', message, options: ['Yes', 'No'] });
    const yes = await this.enqueue<boolean>((done) => ({ type: 'confirm', message, resolve: done }));
    this.emitter.emit('picker_resolved', { choice: yes ? 'yes' : 'no' });
    return yes;
  }

  async ask(message: string): Promise<string> {
    this.emitter.emit('text_input_opened', { prompt: message });
    const answer = await this.enqueue<string>((done) => ({ type: 'ask', message, resolve: done }));
    this.emitter.emit('text_input_resolved', { answer });
    return answer;
  }

  async choose(question: string, options: string[], multiSelect: boolean): Promise<number[]> {
    this.emitter.emit('picker_opened', { kind: 'choose', question, options, multiSelect });
    const picked = await this.enqueue<number[]>((done) => ({
      type: 'choose',
      question,
      options,
      multiSelect,
      resolve: done,
    }));
    this.emitter.emit('picker_resolved', { choice: picked });
    return picked;
  }

  async approve(label: string, detail?: ApproveDetail): Promise<ApproveVerdict> {
    this.emitter.emit('picker_opened', {
      kind: 'approve',
      label,
      tool: detail?.tool,
      options: ['Yes', "Yes, and don't ask again", 'No'],
    });
    const verdict = await this.enqueue<ApproveVerdict>((done) => ({
      type: 'approve',
      label,
      detail,
      resolve: done,
    }));
    this.emitter.emit('picker_resolved', { choice: verdict.decision });
    return verdict;
  }
}
