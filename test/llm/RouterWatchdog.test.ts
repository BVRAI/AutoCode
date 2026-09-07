// The router's request watchdog: a provider that never answers fails as a
// retryable timeout (before the first event) or as a plain timeout (once
// events have flowed) instead of hanging the turn.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CompletionRequest, CompletionResponse, LlmProvider, StreamEvent } from '../../src/llm/types.js';

const saved: Record<string, string | undefined> = {};
beforeAll(() => {
  for (const k of ['AUTOCODE_LLM_FIRST_EVENT_MS', 'AUTOCODE_LLM_IDLE_MS', 'AUTOCODE_LLM_COMPLETE_MS']) saved[k] = process.env[k];
  process.env.AUTOCODE_LLM_FIRST_EVENT_MS = '60';
  process.env.AUTOCODE_LLM_IDLE_MS = '60';
  process.env.AUTOCODE_LLM_COMPLETE_MS = '60';
});
afterAll(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

const REQ: CompletionRequest = { model: 'm', system: 's', messages: [{ role: 'user', content: 'hi' }], tools: [] };
const RESPONSE: CompletionResponse = { model: 'm', stopReason: 'end_turn', content: [{ type: 'text', text: 'ok' }], usage: { inputTokens: 1, outputTokens: 1 } };

function never(signal?: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    signal?.addEventListener('abort', () => reject(Object.assign(new Error('This operation was aborted'), { name: 'AbortError' })));
  });
}

async function routerWith(provider: LlmProvider) {
  // Import after the env is set so the module-level ceilings pick it up.
  const { LlmRouter } = await import('../../src/llm/Router.js');
  const router = new LlmRouter();
  (router as unknown as { cache: Map<string, LlmProvider> }).cache.set('xai', provider);
  return router;
}

describe('LlmRouter watchdog', () => {
  it('turns a silent stream into a retryable timeout and gives up after the retries', async () => {
    let calls = 0;
    const provider: LlmProvider = {
      name: 'xai',
      complete: async () => RESPONSE,
      completeStream: async function* (req: CompletionRequest): AsyncGenerator<StreamEvent> {
        calls += 1;
        await never(req.signal);
        yield { type: 'message_stop', response: RESPONSE };
      },
    } as unknown as LlmProvider;
    const router = await routerWith(provider);
    const events: StreamEvent[] = [];
    await expect(
      (async () => {
        for await (const evt of router.completeStream('xai', REQ)) events.push(evt);
      })(),
    ).rejects.toThrow(/xai timeout: no response for 0s/);
    expect(calls).toBe(3); // MAX_RETRIES attempts, each cut by the watchdog
    expect(events).toEqual([]);
  }, 15_000);

  it('fails a stream that goes quiet after the first event without retrying it', async () => {
    let calls = 0;
    const provider: LlmProvider = {
      name: 'xai',
      complete: async () => RESPONSE,
      completeStream: async function* (req: CompletionRequest): AsyncGenerator<StreamEvent> {
        calls += 1;
        yield { type: 'text_delta', text: 'partial' };
        await never(req.signal);
      },
    } as unknown as LlmProvider;
    const router = await routerWith(provider);
    const events: StreamEvent[] = [];
    await expect(
      (async () => {
        for await (const evt of router.completeStream('xai', REQ)) events.push(evt);
      })(),
    ).rejects.toThrow(/xai timeout: no stream data for 0s/);
    expect(calls).toBe(1);
    expect(events).toHaveLength(1);
  }, 15_000);

  it('times out a non-streaming completion', async () => {
    const provider: LlmProvider = {
      name: 'xai',
      complete: async (req: CompletionRequest) => never(req.signal),
    } as unknown as LlmProvider;
    const router = await routerWith(provider);
    await expect(router.complete('xai', REQ)).rejects.toThrow(/xai timeout: no response/);
  }, 15_000);

  it('retries a stream cut before its first event ("terminated", socket hang up)', async () => {
    let calls = 0;
    const provider: LlmProvider = {
      name: 'xai',
      complete: async () => RESPONSE,
      completeStream: async function* (): AsyncGenerator<StreamEvent> {
        calls += 1;
        if (calls === 1) throw new TypeError('terminated');
        if (calls === 2) throw new Error('socket hang up');
        yield { type: 'message_stop', response: RESPONSE };
      },
    } as unknown as LlmProvider;
    const router = await routerWith(provider);
    const events: StreamEvent[] = [];
    for await (const evt of router.completeStream('xai', REQ)) events.push(evt);
    expect(calls).toBe(3);
    expect(events.map((e) => e.type)).toEqual(['message_stop']);
  }, 15_000);

  it('leaves a healthy stream alone', async () => {
    const provider: LlmProvider = {
      name: 'xai',
      complete: async () => RESPONSE,
      completeStream: async function* (): AsyncGenerator<StreamEvent> {
        yield { type: 'text_delta', text: 'ok' };
        yield { type: 'message_stop', response: RESPONSE };
      },
    } as unknown as LlmProvider;
    const router = await routerWith(provider);
    const events: StreamEvent[] = [];
    for await (const evt of router.completeStream('xai', REQ)) events.push(evt);
    expect(events.map((e) => e.type)).toEqual(['text_delta', 'message_stop']);
  });
});
