import { describe, expect, it } from 'vitest';
import { PresentationRun, nextPresentation, presentationActive } from '../../src/repl/PresentationRun.js';

describe('presentation run scope', () => {
  it('is independent of accounting and allocates unique run/event IDs across resumes', async () => {
    const events = [];
    for (let i = 0; i < 2; i++) {
      await new PresentationRun('one-submission').run(async () => {
        expect(presentationActive()).toBe(true);
        events.push(nextPresentation({ toolCallId: 'same-provider-id' })!);
        await Promise.resolve();
        events.push(nextPresentation()!);
      });
    }
    expect(events.map(e => e.sequence)).toEqual([1, 2, 1, 2]);
    expect(new Set(events.map(e => e.runId)).size).toBe(2);
    expect(new Set(events.map(e => e.eventId)).size).toBe(4);
    expect(events.every(e => e.submissionId === 'one-submission')).toBe(true);
    expect(nextPresentation()).toBeUndefined();
  });

  it('keeps concurrent scopes separate and refuses detached emissions after completion', async () => {
    let finish!: () => void;
    const pending = new Promise<void>(resolve => { finish = resolve; });
    let late!: Promise<unknown>;
    await new PresentationRun('first').run(async () => {
      late = pending.then(() => nextPresentation());
      expect(nextPresentation()?.submissionId).toBe('first');
      await new PresentationRun('second').run(async () => {
        expect(nextPresentation()?.submissionId).toBe('second');
      });
      expect(nextPresentation()?.submissionId).toBe('first');
    });
    finish();
    expect(await late).toBeUndefined();
  });
});
