import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { describeThinking, parseEffortSetting, thinkingFor } from '../../src/llm/models.js';
import { buildBody } from '../../src/llm/providers/openaiCompat.js';
import { AnthropicProvider } from '../../src/llm/providers/AnthropicProvider.js';
import type { CompletionRequest } from '../../src/llm/types.js';

const baseReq: CompletionRequest = {
  model: 'claude-opus-4-7',
  system: 'sys',
  messages: [{ role: 'user', content: 'hi' }],
  tools: [],
};

describe('thinkingFor (effort policy per provider)', () => {
  afterEach(() => {
    delete process.env.AUTOCODE_NO_THINKING;
  });

  it('Anthropic modern shape: adaptive thinking with effort, high by default', () => {
    expect(thinkingFor('anthropic', 'claude-opus-4-7')).toEqual({ mode: 'effort', effort: 'high' });
    expect(thinkingFor('anthropic', 'claude-sonnet-5', 'low')).toEqual({ mode: 'effort', effort: 'low' });
    expect(thinkingFor('anthropic', 'claude-opus-4-7-20251001', 'max')).toEqual({ mode: 'effort', effort: 'max' });
  });

  it('Anthropic legacy shape: a token budget, from the catalog default or the effort level', () => {
    expect(thinkingFor('anthropic', 'claude-sonnet-4-6')).toEqual({ mode: 'budget', budgetTokens: 8192 });
    expect(thinkingFor('anthropic', 'claude-sonnet-4-6-20260101', 'low')).toEqual({ mode: 'budget', budgetTokens: 2048 });
    expect(thinkingFor('anthropic', 'claude-haiku-4-5', 'max')).toEqual({ mode: 'budget', budgetTokens: 32768 });
  });

  it('OpenAI reasoning + gpt-5 models: effort medium by default, with summaries', () => {
    expect(thinkingFor('openai', 'o4-mini')).toEqual({ mode: 'effort', effort: 'medium', summary: true });
    expect(thinkingFor('openai', 'gpt-5.1', 'high')).toEqual({ mode: 'effort', effort: 'high', summary: true });
  });

  it('returns undefined for models without a thinking param (grok-code-fast, gpt-4.1)', () => {
    expect(thinkingFor('xai', 'grok-code-fast-1')).toBeUndefined();
    expect(thinkingFor('openai', 'gpt-4.1')).toBeUndefined();
  });

  it('OpenRouter routes that reach reasoning upstreams get the unified effort', () => {
    expect(thinkingFor('openrouter', 'anthropic/claude-opus-4-7')).toEqual({ mode: 'effort', effort: 'medium' });
    expect(thinkingFor('openrouter', 'meta-llama/llama-3.3-70b')).toBeUndefined();
  });

  it('Gemini: a budget for 2.5, a level for 3, nothing for older families', () => {
    expect(thinkingFor('google', 'gemini-2.5-pro')).toEqual({ mode: 'budget', budgetTokens: 8192, summary: true });
    expect(thinkingFor('google', 'gemini-3-pro')).toEqual({ mode: 'effort', effort: 'high', summary: true });
    expect(thinkingFor('google', 'gemini-3-flash', 'low')).toEqual({ mode: 'effort', effort: 'low', summary: true });
    expect(thinkingFor('google', 'gemini-2.0-flash')).toBeUndefined();
  });

  it('"off" and the AUTOCODE_NO_THINKING kill switch disable thinking everywhere', () => {
    expect(thinkingFor('anthropic', 'claude-opus-4-7', 'off')).toBeUndefined();
    process.env.AUTOCODE_NO_THINKING = '1';
    expect(thinkingFor('anthropic', 'claude-opus-4-7')).toBeUndefined();
  });

  it('parseEffortSetting accepts the six settings, case-insensitively', () => {
    expect(parseEffortSetting('High')).toBe('high');
    expect(parseEffortSetting('auto')).toBe('auto');
    expect(parseEffortSetting('off')).toBe('off');
    expect(parseEffortSetting('turbo')).toBeNull();
    expect(parseEffortSetting(undefined)).toBeNull();
  });

  it('describeThinking phrases the policy for the status line', () => {
    expect(describeThinking({ mode: 'effort', effort: 'high' })).toBe('high effort');
    expect(describeThinking({ mode: 'budget', budgetTokens: 8192 })).toBe('8k budget');
    expect(describeThinking(undefined)).toBeNull();
  });
});

describe('openaiCompat buildBody reasoning', () => {
  it('sets reasoning_effort for o-series models from the requested level', () => {
    const body = buildBody({ ...baseReq, model: 'o4-mini', thinking: { mode: 'effort', effort: 'high' } });
    expect(body.reasoning_effort).toBe('high');
    expect(body.max_completion_tokens).toBeDefined();
    expect(body.temperature).toBeUndefined();
  });

  it('sets reasoning_effort for the gpt-5 family and clamps max to high', () => {
    expect(buildBody({ ...baseReq, model: 'gpt-5.1', thinking: { mode: 'effort', effort: 'medium' } }).reasoning_effort).toBe('medium');
    expect(buildBody({ ...baseReq, model: 'gpt-5.1', thinking: { mode: 'effort', effort: 'max' } }).reasoning_effort).toBe('high');
  });

  it('reads a legacy budget request as medium', () => {
    expect(buildBody({ ...baseReq, model: 'o4-mini', thinking: { mode: 'budget', budgetTokens: 8192 } }).reasoning_effort).toBe('medium');
  });

  it('never sets reasoning_effort without a thinking request', () => {
    expect(buildBody({ ...baseReq, model: 'o4-mini' }).reasoning_effort).toBeUndefined();
  });

  it('never sets reasoning_effort for non-reasoning models in the OpenAI dialect', () => {
    expect(buildBody({ ...baseReq, model: 'grok-code-fast-1', thinking: { mode: 'effort', effort: 'high' } }).reasoning_effort).toBeUndefined();
  });

  it('xAI dialect: low stays low, everything else is high', () => {
    expect(buildBody({ ...baseReq, model: 'grok-4-fast', thinking: { mode: 'effort', effort: 'low' } }, { effortStyle: 'xai' }).reasoning_effort).toBe('low');
    expect(buildBody({ ...baseReq, model: 'grok-4-fast', thinking: { mode: 'effort', effort: 'medium' } }, { effortStyle: 'xai' }).reasoning_effort).toBe('high');
    expect(buildBody({ ...baseReq, model: 'grok-4-fast' }, { effortStyle: 'xai' }).reasoning_effort).toBeUndefined();
  });

  it('OpenRouter dialect: the unified reasoning object', () => {
    const body = buildBody({ ...baseReq, model: 'anthropic/claude-opus-4-7', thinking: { mode: 'effort', effort: 'max' } }, { effortStyle: 'openrouter' });
    expect(body.reasoning).toEqual({ effort: 'high' });
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
  const legacyReq = { ...baseReq, model: 'claude-sonnet-4-6' };

  it('legacy: sends the budget, forces temperature 1, keeps max_tokens above the budget', async () => {
    const p = new AnthropicProvider({ kind: 'byok', apiKey: 'k' });
    await p.complete({
      ...legacyReq,
      maxTokens: 4096,
      temperature: 0,
      thinking: { mode: 'budget', budgetTokens: 8192 },
    });
    const body = sentBody();
    expect(body.thinking).toEqual({ type: 'enabled', budget_tokens: 8192 });
    expect(body.temperature).toBe(1.0);
    expect(body.max_tokens).toBe(8192 + 8192);
    expect(body.output_config).toBeUndefined();
  });

  it('legacy: an effort level maps to a budget', async () => {
    const p = new AnthropicProvider({ kind: 'byok', apiKey: 'k' });
    await p.complete({ ...legacyReq, thinking: { mode: 'effort', effort: 'low' } });
    const body = sentBody();
    expect(body.thinking).toEqual({ type: 'enabled', budget_tokens: 2048 });
    expect(body.output_config).toBeUndefined();
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
    await p.complete({ ...legacyReq, thinking: { mode: 'budget', budgetTokens: 100 } });
    const body = sentBody();
    expect(body.thinking).toEqual({ type: 'enabled', budget_tokens: 1024 });
  });

  // ── Modern shape: Opus 4.7+ / Sonnet 5 / Opus 5 / Fable 5 ────────────────
  it('modern: adaptive thinking plus output_config.effort, never temperature or budget headroom', async () => {
    const p = new AnthropicProvider({ kind: 'byok', apiKey: 'k' });
    await p.complete({
      ...baseReq,
      model: 'claude-opus-4-7',
      maxTokens: 4096,
      temperature: 0,
      thinking: { mode: 'effort', effort: 'high' },
    });
    const body = sentBody();
    expect(body.thinking).toEqual({ type: 'adaptive' });
    expect(body.output_config).toEqual({ effort: 'high' });
    expect(body.temperature).toBeUndefined();
    expect(body.max_tokens).toBe(4096);
  });

  it('modern: a legacy budget request becomes adaptive with no output_config', async () => {
    const p = new AnthropicProvider({ kind: 'byok', apiKey: 'k' });
    await p.complete({ ...baseReq, model: 'claude-opus-4-7', thinking: { mode: 'budget', budgetTokens: 8192 } });
    const body = sentBody();
    expect(body.thinking).toEqual({ type: 'adaptive' });
    expect(body.output_config).toBeUndefined();
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
      await p.complete({ ...baseReq, model, thinking: { mode: 'effort', effort: 'medium' } });
      const body = sentBody();
      expect(body.temperature).toBeUndefined();
      expect(body.thinking).toEqual({ type: 'adaptive' });
      expect(body.output_config).toEqual({ effort: 'medium' });
    },
  );
});
