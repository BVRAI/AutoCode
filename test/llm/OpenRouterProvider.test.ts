import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { OpenRouterProvider } from '../../src/llm/providers/OpenRouterProvider.js';
import type { CompletionRequest } from '../../src/llm/types.js';

const sampleResp = {
  id: 'r',
  model: 'x-ai/grok-code-fast-1',
  choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'hi' } }],
  usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
};

const req: CompletionRequest = {
  model: 'x-ai/grok-code-fast-1',
  system: 'autocode',
  messages: [{ role: 'user', content: 'hello' }],
  tools: [],
};

describe('OpenRouterProvider reasoning echo', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(sampleResp), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('echoes reasoning_details unmodified on the assistant message', async () => {
    // OpenRouter requires the reasoning_details sequence passed back verbatim
    // — any reordering or edit breaks reasoning continuity on tool calls.
    const details = [
      { type: 'reasoning.text', text: 'first', signature: 'sig-1', id: 'a', format: 'anthropic', index: 0 },
      { type: 'reasoning.encrypted', data: 'opaque-blob', id: 'b', index: 1 },
    ];
    const p = new OpenRouterProvider({ kind: 'byok', apiKey: 'or-key' });
    await p.complete({
      ...req,
      messages: [
        { role: 'user', content: 'go' },
        { role: 'assistant', content: [{ type: 'thinking', text: 'first', opaque: details }] },
        { role: 'user', content: 'continue' },
      ],
    });
    const [, init] = fetchSpy.mock.calls[0]!;
    const body = JSON.parse((init as RequestInit).body as string) as {
      messages: Array<{ role: string; reasoning_details?: unknown[] }>;
    };
    const assistant = body.messages.find((m) => m.role === 'assistant')!;
    expect(assistant.reasoning_details).toEqual(details);
  });

  it('parses reasoning + reasoning_details from the response', async () => {
    const details = [{ type: 'reasoning.text', text: 'trace', index: 0 }];
    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          ...sampleResp,
          choices: [
            {
              index: 0,
              finish_reason: 'stop',
              message: { role: 'assistant', content: 'hi', reasoning: 'trace', reasoning_details: details },
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    const p = new OpenRouterProvider({ kind: 'byok', apiKey: 'or-key' });
    const resp = await p.complete(req);
    expect(resp.content[0]).toEqual({ type: 'thinking', text: 'trace', opaque: details });
  });
});
