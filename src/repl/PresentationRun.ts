// Host presentation provenance, independent of accounting and model context.
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

export interface PresentationIdentity {
  version: 1;
  submissionId: string;
  runId: string;
  eventId: string;
  sequence: number;
  toolCallId?: string;
  messageId?: string;
}

const scope = new AsyncLocalStorage<PresentationRun>();

export class PresentationRun {
  readonly runId = randomUUID();
  private sequence = 0;
  private open = false;

  constructor(readonly submissionId: string = randomUUID()) {}

  get isOpen(): boolean { return this.open; }

  async run<T>(work: () => Promise<T>): Promise<T> {
    this.open = true;
    try { return await scope.run(this, work); }
    finally { this.open = false; }
  }

  next(fields: { toolCallId?: string; messageId?: string } = {}): PresentationIdentity | undefined {
    if (!this.open) return undefined;
    return { version: 1, submissionId: this.submissionId, runId: this.runId,
      eventId: randomUUID(), sequence: ++this.sequence, ...fields };
  }
}

export function presentationActive(): boolean {
  return scope.getStore()?.isOpen === true;
}

// Never let detached work inherit the identity of a later submission.
export function nextPresentation(fields: { toolCallId?: string; messageId?: string } = {}): PresentationIdentity | undefined {
  return scope.getStore()?.next(fields);
}
