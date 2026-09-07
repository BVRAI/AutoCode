// The Prompter for a hosted session (Phase 5.1): every question the harness
// would ask on the terminal becomes a `request.*` notification with an id,
// and the host answers with the `respond` method. Unanswered requests fail
// closed (decline / cancel) when the turn is cancelled or the host goes away.

import type { ApproveDetail, ApproveVerdict, Prompter } from '../repl/Prompter.js';
import type { Notify } from './ServerSink.js';

type Pending = { kind: 'confirm' | 'ask' | 'choose' | 'approval'; resolve: (answer: unknown) => void };

export class ServerPrompter implements Prompter {
  private seq = 0;
  private readonly pending = new Map<string, Pending>();

  constructor(private readonly notify: Notify) {}

  private open(kind: Pending['kind'], params: Record<string, unknown>): Promise<unknown> {
    this.seq += 1;
    const requestId = `req_${this.seq}`;
    return new Promise((resolve) => {
      this.pending.set(requestId, { kind, resolve });
      this.notify(`request.${kind}`, { requestId, ...params });
    });
  }

  /** Answer from the host; false when the id is unknown or already answered. */
  respond(requestId: string, answer: Record<string, unknown>): boolean {
    const p = this.pending.get(requestId);
    if (!p) return false;
    this.pending.delete(requestId);
    p.resolve(answer);
    return true;
  }

  /** Fail every open request closed (cancel, shutdown). */
  cancelAll(): void {
    for (const [id, p] of this.pending) {
      this.pending.delete(id);
      p.resolve({ cancelled: true });
    }
  }

  openCount(): number {
    return this.pending.size;
  }

  async confirm(message: string): Promise<boolean> {
    const a = (await this.open('confirm', { message, options: ['Yes', 'No'] })) as Record<string, unknown>;
    return a['answer'] === true || a['answer'] === 'yes' || a['choice'] === 'yes';
  }

  async ask(message: string): Promise<string> {
    const a = (await this.open('ask', { message })) as Record<string, unknown>;
    return typeof a['answer'] === 'string' ? a['answer'] : '';
  }

  async choose(question: string, options: string[], multiSelect: boolean): Promise<number[]> {
    const a = (await this.open('choose', { question, options, multiSelect })) as Record<string, unknown>;
    const raw = a['selected'] ?? a['choice'] ?? a['answer'];
    if (Array.isArray(raw)) return raw.filter((n): n is number => typeof n === 'number' && n >= 0 && n < options.length);
    if (typeof raw === 'number') return raw >= 0 && raw < options.length ? [raw] : [];
    return [];
  }

  async approve(label: string, detail?: ApproveDetail): Promise<ApproveVerdict> {
    const a = (await this.open('approval', {
      label,
      tool: detail?.tool,
      args: detail?.args,
      preview: detail?.preview,
      scope: detail?.scope,
      options: ['accept', 'accept_always', 'decline', 'revise'],
    })) as Record<string, unknown>;
    const d = a['decision'];
    if (d === 'accept' || d === 'accept_always' || d === 'decline' || d === 'revise') {
      return { decision: d, guidance: typeof a['guidance'] === 'string' ? a['guidance'] : undefined };
    }
    if (a['answer'] === true || a['answer'] === 'yes') return { decision: 'accept' };
    return { decision: 'decline' };
  }
}
