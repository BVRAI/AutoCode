import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { thinkingFor } from '../../src/llm/models.js';
import { buildBody } from '../../src/llm/providers/openaiCompat.js';
import { AnthropicProvider } from '../../src/llm/providers/AnthropicProvider.js';
import type { CompletionRequest } from '../../src/llm/types.js';

const baseReq: CompletionRequest = {
  model: 'claude-opus-4-7',
  system: 'sys',
  messages: [{ role: 'user', content: 'hi' }],
  tools: [],
};

describe('thinkingFor (catalog gate)', () => {
  afterEach(() => {
    delete process.env.AUTOCODE_NO_THINKING;
  });

  it('arms thinking for Claude 4-family models with the default budget', () => {
    expect(thinkingFor('anthropic', 'claude-opus-4-7')).toEqual({ budgetTokens: 8192 });
    expect(thinkingFor('anthropic', 'claude-sonnet-4-6-20260101')).toEqual({ budgetTokens: 8192 });
  });

  it('arms thinking for OpenAI reasoning + gpt-5 models', () => {
    expect(thinkingFor('openai', 'o4-mini')).toEqual({ budgetTokens: 8192 });
    expect(thinkingFor('openai', 'gpt-5.1')).toEqual({ budgetTokens: 8192 });
  });

  it('returns undefined for models without a thinking param (grok, gpt-4.1)', () => {
    expect(thinkingFor('xai', 'grok-code-fast-1')).toBeUndefined();
    expect(thinkingFor('openai', 'gpt-4.1')).toBeUndefined();
  });

  it('returns undefined for google (thoughtSignature echo deferred)', () => {
    expect(thinkingFor('google', 'gemini-2.5-pro')).toBeUndefined();
  });

  it('honors the AUTOCODE_NO_THINKING kill switch', () => {
    process.env.AUTOCODE_NO_THINKING = '1';
    expect(thinkingFor('anthropic', 'claude-opus-4-7')).toBeUndefined();
  });
});

describe('openaiCompat buildBody reasoning_effort', () => {
  it('sets reasoning_effort for o-series models when thinking is requested', () => {
    const body = buildBody({ ...baseReq, model: 'o4-mini', thinking: { budgetTokens: 8192 } });
    expect(body.reasoning_effort).toBe('medium');
    expect(body.max_completion_tokens).toBeDefined();
    expect(body.temperature).toBeUndefined();
  });

  it('sets reasoning_effort for gpt-5 family when thinking is requested', () => {
    const body = buildBody({ ...baseReq, model: 'gpt-5.1', thinking: { budgetTokens: 8192 } });
    expect(body.reasoning_effort).toBe('medium');
  });

  it('never sets reasoning_effort without a thinking request', () => {
    const body = buildBody({ ...baseReq, model: 'o4-mini' });
    expect(body.reasoning_effort).toBeUndefined();
  });

  it('never sets reasoning_effort for non-reasoning models even if asked', () => {
    const body = buildBody({ ...baseReq, model: 'grok-code-fast-1', thinking: { budgetTokens: 8192 } });
    expect(body.reasoning_effort).toBeUndefined();
  });
});

describe('AnthropicProvider thinking request param', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch');
    fetchSpy.mockResolvedValue(
      new Response(
        JSON.stringify({
          id: 'm1',
          model: 'claude-opus-4-7',
          stop_reason: 'end_turn',
          content: [{ type: 'text', text: 'ok' }],
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  function sentBody(): Record<string, unknown> {
    const call = fetchSpy.mock.calls[0]!;
    return JSON.parse((call[1] as { body: string }).body) as Record<string, unknown>;
  }

  // ── Legacy shape: Opus 4.6 / Sonnet 4.6 and older ────────────────────────
  // These models still accept sampling params and need an explicit thinking budget.
  // (Previously these three cases were asserted against claude-opus-4-7, which no
  // longer accepts either — see the modern-shape block below.)
  const legacyReq = { ...baseReq, model: 'claude-sonnet-4-6' };

  it('legacy: sends the budget, forces temperature 1, keeps max_tokens above the budget', async () => {
    const p = new AnthropicProvider({ kind: 'byok', apiKey: 'k' });
    await p.complete({
      ...legacyReq,
      maxTokens: 4096,
      temperature: 0,
      thinking: { budgetTokens: 8192 },
    });
    const body = sentBody();
    expect(body.thinking).toEqual({ type: 'enabled', budget_tokens: 8192 });
    expect(body.temperature).toBe(1.0);
    expect(body.max_tokens).toBe(8192 + 8192);
  });

  it('legacy: omits thinking and honors temperature when not requested', async () => {
    const p = new AnthropicProvider({ kind: 'byok', apiKey: 'k' });
    await p.complete({ ...legacyReq, temperature: 0 });
    const body = sentBody();
    expect(body.thinking).toBeUndefined();
    expect(body.temperature).toBe(0);
  });

  it('legacy: clamps the budget to the API minimum of 1024', async () => {
    const p = new AnthropicProvider({ kind: 'byok', apiKey: 'k' });
    await p.complete({ ...legacyReq, thinking: { budgetTokens: 100 } });
    const body = sentBody();
    expect(body.thinking).toEqual({ type: 'enabled', budget_tokens: 1024 });
  });

  // ── Modern shape: Opus 4.7+ / Sonnet 5 / Opus 5 / Fable 5 ────────────────
  // Sampling params AND budget_tokens were REMOVED on these models — sending either
  // returns a 400, which made the entire frontier tier unreachable while temperature
  // went out on every request.
  it('modern: never sends temperature, and uses adaptive thinking instead of a budget', async () => {
    const p = new AnthropicProvider({ kind: 'byok', apiKey: 'k' });
    await p.complete({
      ...baseReq,
      model: 'claude-opus-4-7',
      maxTokens: 4096,
      temperature: 0,
      thinking: { budgetTokens: 8192 },
    });
    const body = sentBody();
    expect(body.thinking).toEqual({ type: 'adaptive' });
    expect(body.temperature).toBeUndefined();
    // Adaptive thinking paces itself, so no budget headroom is added.
    expect(body.max_tokens).toBe(4096);
  });

  it('modern: omits temperature even when thinking is off', async () => {
    const p = new AnthropicProvider({ kind: 'byok', apiKey: 'k' });
    await p.complete({ ...baseReq, model: 'claude-opus-4-7', temperature: 0 });
    const body = sentBody();
    expect(body.thinking).toBeUndefined();
    expect(body.temperature).toBeUndefined();
  });

  it.each(['claude-opus-4-7-20251001', 'claude-sonnet-5', 'claude-opus-5', 'claude-opus-4-8'])(
    'modern: %s is recognised (dated variants and newer ids included)',
    async (model) => {
      const p = new AnthropicProvider({ kind: 'byok', apiKey: 'k' });
      await p.complete({ ...baseReq, model, thinking: { budgetTokens: 8192 } });
      const body = sentBody();
      expect(body.temperature).toBeUndefined();
      expect(body.thinking).toEqual({ type: 'adaptive' });
    },
  );
});
