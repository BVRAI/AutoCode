import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { XaiProvider, isReasoningParamRejection, resetReasoningParamMemo } from '../../src/llm/providers/XaiProvider.js';
import type { CompletionRequest } from '../../src/llm/types.js';

const ok = {
  id: 'r',
  model: 'grok-build-0.1',
  choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'hi' } }],
  usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
};
const rejection = JSON.stringify({ code: 'invalid-argument', error: 'Model grok-build-0.1 does not support parameter reasoningEffort.' });

const req: CompletionRequest = {
  model: 'grok-build-0.1',
  system: 'autocode',
  messages: [{ role: 'user', content: 'hello' }],
  tools: [],
  thinking: { mode: 'effort', effort: 'high' },
};

const bodyOf = (call: unknown[]): Record<string, unknown> => JSON.parse((call[1] as { body: string }).body) as Record<string, unknown>;

describe('XaiProvider and the reasoning_effort parameter', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    resetReasoningParamMemo();
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    resetReasoningParamMemo();
  });

  it('recognises xAI’s complaint and nothing else', () => {
    expect(isReasoningParamRejection(400, rejection)).toBe(true);
    expect(isReasoningParamRejection(400, '{"error":"Model grok-build-0.1 does not exist"}')).toBe(false);
    expect(isReasoningParamRejection(500, rejection)).toBe(false);
  });

  it('retries once without the parameter and remembers the model for the session', async () => {
    // A fresh Response per call: a body can only be read once.
    fetchSpy
      .mockResolvedValueOnce(new Response(rejection, { status: 400, headers: { 'content-type': 'application/json' } }))
      .mockImplementation(async () => new Response(JSON.stringify(ok), { status: 200, headers: { 'content-type': 'application/json' } }));
    const provider = new XaiProvider({ kind: 'byok', apiKey: 'k' });

    const first = await provider.complete(req);
    expect(first.content.some((b) => b.type === 'text' && b.text === 'hi')).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(bodyOf(fetchSpy.mock.calls[0]!).reasoning_effort).toBe('high');
    expect(bodyOf(fetchSpy.mock.calls[1]!).reasoning_effort).toBeUndefined();

    await provider.complete(req);
    expect(fetchSpy).toHaveBeenCalledTimes(3);
    expect(bodyOf(fetchSpy.mock.calls[2]!).reasoning_effort).toBeUndefined();
  });

  it('surfaces any other 400 unchanged', async () => {
    fetchSpy.mockResolvedValue(new Response('{"error":"bad request"}', { status: 400 }));
    const provider = new XaiProvider({ kind: 'byok', apiKey: 'k' });
    await expect(provider.complete(req)).rejects.toThrow(/xai 400/);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});
