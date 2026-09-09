import { afterEach, describe, expect, it, vi } from 'vitest';
import { AnthropicProvider } from '../../src/llm/providers/AnthropicProvider.js';
import { streamGemini } from '../../src/llm/providers/GeminiProvider.js';
import { streamOpenAiCompat } from '../../src/llm/providers/openaiCompat.js';
import { parseResponsesOutput } from '../../src/llm/providers/openaiResponses.js';
import type { CompletionResponse, StreamEvent } from '../../src/llm/types.js';

async function lastResponse(events: AsyncIterable<StreamEvent>): Promise<CompletionResponse> {
  let result: CompletionResponse | undefined;
  for await (const event of events) if (event.type === 'message_stop') result = event.response;
  expect(result).toBeDefined();
  return result!;
}

afterEach(() => vi.restoreAllMocks());

describe('provider accounting provenance', () => {
  it('distinguishes omitted usage from an explicit zero-token response', async () => {
    const payload = { model: 'resolved', output: [], status: 'completed' };
    expect(parseResponsesOutput(payload).usageAvailable).toBe(false);
    expect(parseResponsesOutput({ ...payload, usage: { input_tokens: 0, output_tokens: 0 } }).usageAvailable).toBe(true);
    const stream = `data: ${JSON.stringify({ choices: [{ finish_reason: 'stop', delta: {} }] })}\n\n`;
    const result = await lastResponse(streamOpenAiCompat(new Response(stream), 'requested'));
    expect(result.usage).toEqual({ inputTokens: 0, outputTokens: 0 });
    expect(result.usageAvailable).toBe(false);
  });

  it('preserves legacy Gemini counters while billing cached input once and including thinking output', async () => {
    const chunk = { modelVersion: 'resolved-gemini',
      candidates: [{ content: { parts: [{ text: 'hello' }] }, finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: 1000, candidatesTokenCount: 10, thoughtsTokenCount: 50, cachedContentTokenCount: 400 },
    };
    const result = await lastResponse(streamGemini(new Response(`data: ${JSON.stringify(chunk)}\n\n`), 'requested'));
    expect(result.usage).toEqual({ inputTokens: 1000, outputTokens: 10, cacheReadTokens: 400 });
    expect(result.accountingUsage).toEqual({ inputTokens: 600, outputTokens: 60, cacheReadTokens: 400 });
    expect(result.usageAvailable).toBe(true);
    expect(result.accountingComplete).toBe(true);
    const incomplete = await lastResponse(streamGemini(new Response('data: {"candidates":[]}\n\n'), 'requested'));
    expect(incomplete.usageAvailable).toBe(false);
    expect(incomplete.accountingComplete).toBe(false);
  });

  it('does not infer Anthropic terminal success or usage from synthetic message_stop on a cut stream', async () => {
    const records = [
      ['message_start', { message: { model: 'claude-sonnet-5', usage: { input_tokens: 10 } } }],
      ['message_delta', { usage: { output_tokens: 4 }, delta: { stop_reason: 'end_turn' } }],
    ];
    const wire = records.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join('');
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(wire));
    const result = await lastResponse(new AnthropicProvider({ kind: 'byok', apiKey: 'fake' }).completeStream({ model: 'requested', system: '', messages: [], tools: [] }));
    expect(result.model).toBe('requested'); // Existing engine-facing behavior.
    expect(result.accountingModel).toBe('claude-sonnet-5');
    expect(result.usageAvailable).toBe(true);
    expect(result.accountingComplete).toBe(false);
  });

  it('uses the streamed resolved OpenAI-compatible model for accounting without rewriting engine fields', async () => {
    const chunk = { model: 'resolved-model', choices: [{ finish_reason: 'stop', delta: {} }], usage: { prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 40 } } };
    const result = await lastResponse(streamOpenAiCompat(new Response(`data: ${JSON.stringify(chunk)}\n\n`), 'requested'));
    expect(result.model).toBe('requested');
    expect(result.accountingModel).toBe('resolved-model');
    expect(result.usage).toEqual({ inputTokens: 60, outputTokens: 20, cacheReadTokens: 40 });
    expect(result.usageAvailable).toBe(true);
    expect(result.accountingComplete).toBe(true);
  });
});
