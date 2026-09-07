import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { GeminiProvider, streamGemini } from '../../src/llm/providers/GeminiProvider.js';
import type { CompletionRequest, StreamEvent } from '../../src/llm/types.js';

const req: CompletionRequest = {
  model: 'gemini-2.5-pro',
  system: 'autocode',
  messages: [{ role: 'user', content: 'hello' }],
  tools: [],
};

const textOnlyResp = {
  modelVersion: 'gemini-2.5-pro',
  candidates: [
    { content: { role: 'model', parts: [{ text: 'plain answer' }] }, finishReason: 'STOP' },
  ],
  usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 2 },
};

function sentBody(spy: ReturnType<typeof vi.spyOn>): Record<string, unknown> {
  const [, init] = spy.mock.calls[0]!;
  return JSON.parse((init as RequestInit).body as string) as Record<string, unknown>;
}

describe('GeminiProvider thinking handling', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // A fresh Response per call — a body can only be read once.
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      new Response(JSON.stringify(textOnlyResp), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('maps thought parts to thinking blocks (kept out of visible text)', async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          modelVersion: 'gemini-2.5-pro',
          candidates: [
            {
              content: {
                role: 'model',
                parts: [
                  { text: 'internal reasoning', thought: true, thoughtSignature: 'tsig-1' },
                  { text: 'visible answer' },
                ],
              },
              finishReason: 'STOP',
            },
          ],
          usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 2 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    const p = new GeminiProvider({ kind: 'byok', apiKey: 'g-key' });
    const resp = await p.complete(req);
    expect(resp.content[0]).toEqual({
      type: 'thinking',
      text: 'internal reasoning',
      opaque: { thoughtSignature: 'tsig-1' },
    });
    expect(resp.content[1]).toEqual({ type: 'text', text: 'visible answer' });
  });

  it('keeps a signature on the function call that carried it and replays it on the same part', async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          modelVersion: 'gemini-3-pro',
          candidates: [
            {
              content: {
                role: 'model',
                parts: [
                  { text: 'thinking…', thought: true },
                  { functionCall: { name: 'read_file', args: { path: 'a.ts' } }, thoughtSignature: 'sig-fc' },
                ],
              },
              finishReason: 'STOP',
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    const p = new GeminiProvider({ kind: 'byok', apiKey: 'g-key' });
    const resp = await p.complete({ ...req, model: 'gemini-3-pro' });
    expect(resp.content[1]).toEqual({
      type: 'tool_use',
      id: 'gem-1',
      name: 'read_file',
      input: { path: 'a.ts' },
      opaque: { thoughtSignature: 'sig-fc' },
    });

    fetchSpy.mockClear();
    await p.complete({
      ...req,
      model: 'gemini-3-pro',
      messages: [
        { role: 'user', content: 'go' },
        { role: 'assistant', content: resp.content },
        { role: 'user', content: [{ type: 'tool_result', toolUseId: 'gem-1', content: 'line 1' }] },
      ],
    });
    const body = sentBody(fetchSpy) as { contents: Array<{ role: string; parts: Array<Record<string, unknown>> }> };
    const model = body.contents.find((c) => c.role === 'model')!;
    expect(model.parts).toEqual([
      { functionCall: { name: 'read_file', args: { path: 'a.ts' } }, thoughtSignature: 'sig-fc' },
    ]);
    const reply = body.contents[2]!;
    expect(reply.parts).toEqual([{ functionResponse: { name: 'read_file', response: { output: 'line 1' } } }]);
  });

  it('carries a thought block signature onto the next text part instead of replaying thought text', async () => {
    const p = new GeminiProvider({ kind: 'byok', apiKey: 'g-key' });
    await p.complete({
      ...req,
      messages: [
        { role: 'user', content: 'go' },
        {
          role: 'assistant',
          content: [
            { type: 'thinking', text: 'reasoning', opaque: { thoughtSignature: 'tsig' } },
            { type: 'text', text: 'ok' },
          ],
        },
        { role: 'user', content: 'continue' },
      ],
    });
    const body = sentBody(fetchSpy) as { contents: Array<{ role: string; parts: Array<Record<string, unknown>> }> };
    const model = body.contents.find((c) => c.role === 'model')!;
    expect(model.parts).toEqual([{ text: 'ok', thoughtSignature: 'tsig' }]);
  });

  it('arms thinkingLevel for Gemini 3 and thinkingBudget for Gemini 2.5', async () => {
    const p = new GeminiProvider({ kind: 'byok', apiKey: 'g-key' });
    await p.complete({ ...req, model: 'gemini-3-pro', thinking: { mode: 'effort', effort: 'max', summary: true } });
    let cfg = (sentBody(fetchSpy) as { generationConfig: Record<string, unknown> }).generationConfig;
    expect(cfg.thinkingConfig).toEqual({ includeThoughts: true, thinkingLevel: 'HIGH' });

    fetchSpy.mockClear();
    await p.complete({ ...req, thinking: { mode: 'budget', budgetTokens: 4096, summary: true } });
    cfg = (sentBody(fetchSpy) as { generationConfig: Record<string, unknown> }).generationConfig;
    expect(cfg.thinkingConfig).toEqual({ includeThoughts: true, thinkingBudget: 4096 });
  });

  it('streams through :streamGenerateContent?alt=sse', async () => {
    fetchSpy.mockResolvedValueOnce(new Response('data: {"candidates":[{"content":{"parts":[{"text":"hi"}]},"finishReason":"STOP"}]}\n\n'));
    const p = new GeminiProvider({ kind: 'byok', apiKey: 'g-key' });
    const events: StreamEvent[] = [];
    for await (const e of p.completeStream(req)) events.push(e);
    const [url, init] = fetchSpy.mock.calls[0]! as [string, RequestInit];
    expect(url).toContain(':streamGenerateContent?alt=sse');
    expect((init.headers as Record<string, string>)['accept']).toBe('text/event-stream');
    expect(events.map((e) => e.type)).toEqual(['text_delta', 'message_stop']);
  });
});

describe('streamGemini', () => {
  function sse(chunks: unknown[]): Response {
    return new Response(chunks.map((c) => `data: ${JSON.stringify(c)}`).join('\n\n') + '\n\n');
  }

  it('merges thought and text deltas, emits whole function calls, and folds everything into message_stop', async () => {
    const events: StreamEvent[] = [];
    for await (const e of streamGemini(
      sse([
        { modelVersion: 'gemini-3-pro', candidates: [{ content: { parts: [{ text: 'Let me ', thought: true }] } }] },
        { candidates: [{ content: { parts: [{ text: 'think.', thought: true }] } }] },
        { candidates: [{ content: { parts: [{ text: 'Reading ' }] } }] },
        { candidates: [{ content: { parts: [{ text: 'the file.', thoughtSignature: 'sig-text' }] } }] },
        {
          candidates: [
            {
              content: { parts: [{ functionCall: { name: 'read_file', args: { path: 'a.ts' } }, thoughtSignature: 'sig-fc' }] },
              finishReason: 'STOP',
            },
          ],
          usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 7 },
        },
      ]),
      'gemini-3-pro',
    )) {
      events.push(e);
    }
    expect(events.map((e) => e.type)).toEqual([
      'thinking_delta',
      'thinking_delta',
      'text_delta',
      'text_delta',
      'tool_use_start',
      'tool_use_delta',
      'tool_use_stop',
      'message_stop',
    ]);
    const stop = events[events.length - 1]!;
    if (stop.type === 'message_stop') {
      expect(stop.response.model).toBe('gemini-3-pro');
      expect(stop.response.content).toEqual([
        { type: 'thinking', text: 'Let me think.' },
        { type: 'text', text: 'Reading the file.', opaque: { thoughtSignature: 'sig-text' } },
        { type: 'tool_use', id: 'gem-1', name: 'read_file', input: { path: 'a.ts' }, opaque: { thoughtSignature: 'sig-fc' } },
      ]);
      expect(stop.response.usage).toEqual({ inputTokens: 12, outputTokens: 7, cacheReadTokens: 0 });
    }
  });
});
