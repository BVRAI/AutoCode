import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { GeminiProvider } from '../../src/llm/providers/GeminiProvider.js';
import type { CompletionRequest } from '../../src/llm/types.js';

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

describe('GeminiProvider thinking handling', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
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

  it('omits thinking blocks from outbound contents (echo deferred)', async () => {
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
    const [, init] = fetchSpy.mock.calls[0]!;
    const body = JSON.parse((init as RequestInit).body as string) as {
      contents: Array<{ role: string; parts: Array<Record<string, unknown>> }>;
    };
    const model = body.contents.find((c) => c.role === 'model')!;
    expect(model.parts).toEqual([{ text: 'ok' }]);
  });
});
