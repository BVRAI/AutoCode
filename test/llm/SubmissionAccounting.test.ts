import { describe, expect, it, vi } from 'vitest';
import { SubmissionAccounting, currentSubmissionId, type UsageReceipt } from '../../src/llm/SubmissionAccounting.js';
import { LlmRouter } from '../../src/llm/Router.js';
import type { CompletionRequest, CompletionResponse, LlmProvider, StreamEvent } from '../../src/llm/types.js';
import { estimateCost, setDiscoveredRates, setProxyRates } from '../../src/util/pricing.js';

const req: CompletionRequest = { model: 'requested-alias', system: 'unchanged', messages: [{ role: 'user', content: 'hello' }], tools: [] };
const response = (model = 'gpt-5.6-terra'): CompletionResponse => ({ model, stopReason: 'end_turn', content: [{ type: 'text', text: 'done' }],
  usage: { inputTokens: 1000, outputTokens: 100, cacheReadTokens: 500 } });

function recorder(submissionId = 'submission-1') {
  const events: { method: string; params: Record<string, unknown> }[] = [];
  const accounting = new SubmissionAccounting(submissionId, (method, params) => events.push({ method, params }));
  return { accounting, events, receipts: () => events.filter(e => e.method === 'accounting.receipt').map(e => e.params as unknown as UsageReceipt) };
}

function router(provider: LlmProvider): LlmRouter {
  const instance = new LlmRouter();
  const cache = (instance as unknown as { cache: Map<string, LlmProvider> }).cache;
  cache.set('openai', provider);
  cache.set('anthropic', provider);
  return instance;
}

describe('submission usage receipts', () => {
  it('prices each resolved model including parallel delegated/judge calls, without changing responses or requests', async () => {
    const r = recorder();
    const first = response();
    const second = { ...response('claude-sonnet-5'), usage: { inputTokens: 200, outputTokens: 30, cacheReadTokens: 100, cacheWriteTokens: 20 } };
    const provider = { name: 'scripted', complete: vi.fn(async (request: CompletionRequest) => request.model === 'second' ? second : first) };
    const subject = router(provider);
    const original = JSON.stringify(req);
    const results = await r.accounting.run(() => Promise.all([
      subject.complete('openai', req), subject.complete('anthropic', { ...req, model: 'second' }),
    ]));
    expect(results).toEqual([first, second]);
    expect(JSON.stringify(req)).toBe(original);
    const receipts = r.receipts();
    expect(receipts).toHaveLength(2);
    expect(receipts[0]?.costUsd).toBeCloseTo(0.0033);
    expect(receipts[1]?.costUsd).toBeCloseTo(0.00077);
    expect(new Set(receipts.map(x => x.callId)).size).toBe(2);
    expect(receipts.every(x => x.complete && x.submissionId === 'submission-1')).toBe(true);
    expect(r.events.at(-1)?.params.complete).toBe(true);
    expect(currentSubmissionId()).toBeUndefined();
  });

  it('accounts a streamed response once even if message_stop is duplicated', async () => {
    const r = recorder();
    const result = response();
    const subject = router({ name: 'scripted', complete: async () => result, completeStream: async function* () {
      yield { type: 'text_delta', text: 'done' } as StreamEvent;
      yield { type: 'message_stop', response: result } as StreamEvent;
      yield { type: 'message_stop', response: result } as StreamEvent;
    } });
    const events: StreamEvent[] = [];
    await r.accounting.run(async () => { for await (const event of subject.completeStream('openai', req)) events.push(event); });
    expect(events).toHaveLength(3); // Accounting does not rewrite the stream.
    expect(r.receipts()).toHaveLength(1);
    expect(r.receipts()[0]?.complete).toBe(true);
  });

  it('retains known usage from a stream cut after its response as partial; does not retry it', async () => {
    const r = recorder();
    let calls = 0;
    const subject = router({ name: 'scripted', complete: async () => response(), completeStream: async function* () {
      calls++;
      yield { type: 'message_stop', response: response() } as StreamEvent;
      throw new Error('terminated');
    } });
    await expect(r.accounting.run(async () => { for await (const _ of subject.completeStream('openai', req)) {} })).rejects.toThrow('terminated');
    expect(calls).toBe(1);
    expect(r.receipts()[0]).toMatchObject({ costUsd: expect.any(Number), complete: false });
    expect(r.events.at(-1)?.params.complete).toBe(false);
  });

  it('marks interrupted streams and successful responses without usage unknown, not free', async () => {
    const r = recorder();
    const subject = router({ name: 'scripted', complete: async () => ({ ...response(), usageAvailable: false }), completeStream: async function* () {
      yield { type: 'text_delta', text: 'unfinished' } as StreamEvent;
    } });
    await r.accounting.run(async () => {
      await subject.complete('openai', req);
      for await (const _ of subject.completeStream('openai', req)) {}
    });
    expect(r.receipts()).toHaveLength(2);
    for (const receipt of r.receipts()) expect(receipt).toMatchObject({ usageAvailable: false, pricingAvailable: false, costUsd: null, complete: false });
  });

  it('keeps retries separate and marks unknown failed attempts partial, with unchanged retry policy', async () => {
    const r = recorder();
    let calls = 0;
    const subject = router({ name: 'scripted', complete: async () => { if (++calls === 1) throw new Error('openai 429 rate limit'); return response(); } });
    await r.accounting.run(() => subject.complete('openai', req));
    expect(calls).toBe(2);
    expect(r.receipts()).toHaveLength(2);
    expect(r.receipts()[0]).toMatchObject({ usageAvailable: false, costUsd: null, complete: false });
    expect(r.receipts()[1]?.complete).toBe(true);
    expect(r.events.at(-1)?.params.complete).toBe(false);
  });

  it('distinguishes unknown pricing and missing cache rates, preserving a known subtotal', async () => {
    setDiscoveredRates('openai', { 'test-no-cache': { inputPerM: 2, outputPerM: 12 } });
    try {
      const r = recorder();
      const subject = router({ name: 'scripted', complete: async request => response(request.model) });
      await r.accounting.run(async () => {
        await subject.complete('openai', { ...req, model: 'not-priced-anywhere' });
        await subject.complete('openai', { ...req, model: 'test-no-cache' });
      });
      expect(r.receipts()[0]).toMatchObject({ usageAvailable: true, pricingAvailable: false, costUsd: null, complete: false });
      expect(r.receipts()[1]).toMatchObject({ pricingAvailable: false, complete: false });
      expect(r.receipts()[1]?.costUsd).toBeCloseTo(0.0032);
    } finally { setDiscoveredRates('openai', null); }
  });

  it('correlates concurrent submissions and repair runs explicitly; ignores late work after the original scope closes', async () => {
    const a = recorder('A'), b = recorder('B'), repair = recorder('A');
    let finishLate: ((response: CompletionResponse, finished: boolean) => void) | undefined;
    await a.accounting.run(async () => { finishLate = a.accounting.beginCall('openai', req.model); });
    expect(a.events.at(-1)?.params.complete).toBe(false);
    const subject = router({ name: 'scripted', complete: async () => response() });
    await Promise.all([b.accounting.run(() => subject.complete('openai', req)), repair.accounting.run(() => subject.complete('openai', req))]);
    finishLate!(response(), true);
    expect(a.receipts()).toEqual([]);
    expect(b.receipts()[0]?.submissionId).toBe('B');
    expect(repair.receipts()[0]?.submissionId).toBe('A');
    expect(repair.accounting.runId).not.toBe(a.accounting.runId);
  });

  it('does not label cached-only usage free when its cache price is unknown', async () => {
    setDiscoveredRates('openai', {
      'test-unpriced-cache': { inputPerM: 2, outputPerM: 12 },
      'test-free-cache': { inputPerM: 2, outputPerM: 12, cacheReadPerM: 0 },
    });
    try {
      const r = recorder();
      const subject = router({ name: 'scripted', complete: async request => ({ ...response(request.model),
        usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: request.messages.length === 0 ? 0 : 500 },
      }) });
      await r.accounting.run(async () => {
        await subject.complete('openai', { ...req, model: 'test-unpriced-cache' });
        await subject.complete('openai', { ...req, model: 'test-free-cache' });
        await subject.complete('openai', { ...req, model: 'test-unpriced-cache', messages: [] });
      });
      expect(r.receipts()[0]).toMatchObject({ usageAvailable: true, pricingAvailable: false, costUsd: null, complete: false });
      expect(r.receipts()[1]).toMatchObject({ pricingAvailable: true, costUsd: 0, complete: true });
      expect(r.receipts()[2]).toMatchObject({ pricingAvailable: true, costUsd: 0, complete: true });
    } finally { setDiscoveredRates('openai', null); }
  });

  it('does not treat a pending catalog 0/0 placeholder as free, while leaving budget estimates unchanged', async () => {
    const catalog = { providers: { openai: { models: [
      { id: 'test-pending', status: 'pricing_pending', input_price_per_million: 0, output_price_per_million: 0 },
      { id: 'test-known-cache', status: 'active', input_price_per_million: 2, output_price_per_million: 12,
        supports_caching: true, cache_read_multiplier: 0 },
    ] } } };
    setProxyRates(catalog);
    try {
      const r = recorder();
      const subject = router({ name: 'scripted', complete: async request => ({ ...response(request.model),
        usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 500 },
      }) });
      await r.accounting.run(async () => {
        await subject.complete('openai', { ...req, model: 'test-pending' });
        await subject.complete('openai', { ...req, model: 'test-known-cache' });
      });
      expect(r.receipts()[0]).toMatchObject({ usageAvailable: true, pricingAvailable: false, costUsd: null, complete: false });
      expect(r.receipts()[1]).toMatchObject({ pricingAvailable: true, costUsd: 0, complete: true });
      expect(estimateCost({ inputTokens: 100, outputTokens: 20 }, 'openai', 'test-pending').cost).toBe(0);
    } finally { setProxyRates(null); }
  });

  it('does not fail model work when accounting callbacks fail and does not create receipts outside a scope', async () => {
    const subject = router({ name: 'scripted', complete: async () => response() });
    const accounting = new SubmissionAccounting('A', () => { throw new Error('host closed'); });
    await expect(accounting.run(() => subject.complete('openai', req))).resolves.toEqual(response());
    await expect(subject.complete('openai', req)).resolves.toEqual(response());
  });
});
