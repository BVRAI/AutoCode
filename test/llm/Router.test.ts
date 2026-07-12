import { describe, expect, it } from 'vitest';
import { LlmRouter } from '../../src/llm/Router.js';
import type {
  CompletionRequest,
  CompletionResponse,
  LlmProvider,
  StreamEvent,
} from '../../src/llm/types.js';

// Seed the router's private provider cache with a fake — providerFor()
// returns cached instances before consulting auth, so no keys are needed.
function routerWith(provider: LlmProvider): LlmRouter {
  const router = new LlmRouter();
  (router as unknown as { cache: Map<string, LlmProvider> }).cache.set('anthropic', provider);
  return router;
}

const REQ: CompletionRequest = {
  model: 'claude-opus-4-7',
  system: 'sys',
  messages: [{ role: 'user', content: 'hi' }],
  tools: [],
};

const RESPONSE: CompletionResponse = {
  model: 'claude-opus-4-7',
  stopReason: 'end_turn',
  content: [{ type: 'text', text: 'ok' }],
  usage: { inputTokens: 1, outputTokens: 1 },
};

function eventsFor(text: string): StreamEvent[] {
  return [
    { type: 'text_delta', text },
    { type: 'message_stop', response: RESPONSE },
  ];
}

async function collect(stream: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const evt of stream) out.push(evt);
  return out;
}

describe('LlmRouter.completeStream retry', () => {
  it('retries a retryable pre-yield failure and then succeeds', async () => {
    let calls = 0;
    const provider: LlmProvider = {
      name: 'anthropic',
      complete: async () => RESPONSE,
      // eslint-disable-next-line require-yield
      completeStream: async function* (): AsyncIterable<StreamEvent> {
        calls += 1;
        if (calls === 1) throw new Error('anthropic 529: overloaded');
        yield* eventsFor('hello');
      },
    };
    const events = await collect(routerWith(provider).completeStream('anthropic', REQ));
    expect(calls).toBe(2);
    expect(events.map((e) => e.type)).toEqual(['text_delta', 'message_stop']);
  }, 15_000);

  it('does NOT retry once events have been yielded (no duplicate deltas)', async () => {
    let calls = 0;
    const provider: LlmProvider = {
      name: 'anthropic',
      complete: async () => RESPONSE,
      completeStream: async function* (): AsyncIterable<StreamEvent> {
        calls += 1;
        yield { type: 'text_delta', text: 'partial' };
        throw new Error('anthropic 529: overloaded');
      },
    };
    await expect(collect(routerWith(provider).completeStream('anthropic', REQ))).rejects.toThrow(
      /overloaded/,
    );
    expect(calls).toBe(1);
  });

  it('does NOT retry non-retryable errors', async () => {
    let calls = 0;
    const provider: LlmProvider = {
      name: 'anthropic',
      complete: async () => RESPONSE,
      // eslint-disable-next-line require-yield
      completeStream: async function* (): AsyncIterable<StreamEvent> {
        calls += 1;
        throw new Error('anthropic 400: invalid request');
      },
    };
    await expect(collect(routerWith(provider).completeStream('anthropic', REQ))).rejects.toThrow(
      /400/,
    );
    expect(calls).toBe(1);
  });

  it('does NOT retry when the request was aborted', async () => {
    let calls = 0;
    const ac = new AbortController();
    const provider: LlmProvider = {
      name: 'anthropic',
      complete: async () => RESPONSE,
      // eslint-disable-next-line require-yield
      completeStream: async function* (): AsyncIterable<StreamEvent> {
        calls += 1;
        ac.abort();
        throw new Error('anthropic 529: overloaded');
      },
    };
    await expect(
      collect(routerWith(provider).completeStream('anthropic', { ...REQ, signal: ac.signal })),
    ).rejects.toThrow(/overloaded/);
    expect(calls).toBe(1);
  });

  it('gives up after MAX_RETRIES attempts', async () => {
    let calls = 0;
    const provider: LlmProvider = {
      name: 'anthropic',
      complete: async () => RESPONSE,
      // eslint-disable-next-line require-yield
      completeStream: async function* (): AsyncIterable<StreamEvent> {
        calls += 1;
        throw new Error('anthropic 529: overloaded');
      },
    };
    await expect(collect(routerWith(provider).completeStream('anthropic', REQ))).rejects.toThrow(
      /overloaded/,
    );
    expect(calls).toBe(3);
  }, 15_000);
});

describe('LlmRouter.complete retry (existing behavior)', () => {
  it('retries a retryable failure and then succeeds', async () => {
    let calls = 0;
    const provider: LlmProvider = {
      name: 'anthropic',
      complete: async () => {
        calls += 1;
        if (calls === 1) throw new Error('anthropic 429: rate limit');
        return RESPONSE;
      },
    };
    const resp = await routerWith(provider).complete('anthropic', REQ);
    expect(calls).toBe(2);
    expect(resp.stopReason).toBe('end_turn');
  }, 15_000);
});
