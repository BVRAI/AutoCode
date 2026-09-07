import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  buildResponsesBody,
  parseResponsesOutput,
  streamResponses,
  toResponsesItems,
} from '../../src/llm/providers/openaiResponses.js';
import { OpenAIProvider } from '../../src/llm/providers/OpenAIProvider.js';
import type { CompletionRequest, StreamEvent } from '../../src/llm/types.js';

const baseReq: CompletionRequest = {
  model: 'gpt-5.1',
  system: 'sys',
  systemVolatile: 'branch: main',
  messages: [{ role: 'user', content: 'hi' }],
  tools: [{ name: 'read_file', description: 'Read a file', inputSchema: { type: 'object', properties: { path: { type: 'string' } } } }],
};

const reasoningItem = {
  type: 'reasoning' as const,
  id: 'rs_1',
  summary: [{ type: 'summary_text' as const, text: 'Plan: read the file.' }],
  encrypted_content: 'ENCRYPTED',
};

describe('buildResponsesBody', () => {
  it('carries the system prompt as instructions and messages as input items', () => {
    const body = buildResponsesBody(baseReq);
    expect(body.instructions).toBe('sys\nbranch: main');
    expect(body.input).toEqual([{ role: 'user', content: [{ type: 'input_text', text: 'hi' }] }]);
    expect(body.tools).toEqual([
      { type: 'function', name: 'read_file', description: 'Read a file', parameters: baseReq.tools[0]!.inputSchema },
    ]);
    expect(body.tool_choice).toBe('auto');
    expect(body.store).toBe(false);
    expect(body.max_output_tokens).toBe(8192);
  });

  it('arms reasoning with the effort level, asks for summaries and encrypted items, and drops temperature', () => {
    const body = buildResponsesBody({ ...baseReq, temperature: 0, thinking: { mode: 'effort', effort: 'max', summary: true } });
    expect(body.reasoning).toEqual({ effort: 'high', summary: 'auto' });
    expect(body.include).toEqual(['reasoning.encrypted_content']);
    expect(body.temperature).toBeUndefined();
  });

  it('sends temperature only to non-reasoning models', () => {
    expect(buildResponsesBody({ ...baseReq, model: 'gpt-4.1', temperature: 0 }).temperature).toBe(0);
    expect(buildResponsesBody({ ...baseReq, model: 'gpt-4.1', temperature: 0, thinking: { mode: 'effort', effort: 'high' } }).reasoning).toBeUndefined();
    expect(buildResponsesBody({ ...baseReq, model: 'o4-mini', temperature: 0 }).temperature).toBeUndefined();
  });

  it('replays an assistant turn as reasoning item, message and function calls, then the tool output', () => {
    const items = [
      ...toResponsesItems({
        role: 'assistant',
        content: [
          { type: 'thinking', text: 'Plan: read the file.', opaque: reasoningItem },
          { type: 'text', text: 'Reading.' },
          { type: 'tool_use', id: 'call_1', name: 'read_file', input: { path: 'a.ts' } },
        ],
      }),
      ...toResponsesItems({ role: 'user', content: [{ type: 'tool_result', toolUseId: 'call_1', content: 'line 1' }] }),
    ];
    expect(items).toEqual([
      reasoningItem,
      { role: 'assistant', content: [{ type: 'output_text', text: 'Reading.' }] },
      { type: 'function_call', call_id: 'call_1', name: 'read_file', arguments: '{"path":"a.ts"}' },
      { type: 'function_call_output', call_id: 'call_1', output: 'line 1' },
    ]);
  });

  it('does not replay a text-only thinking trace (nothing the API can verify)', () => {
    expect(toResponsesItems({ role: 'assistant', content: [{ type: 'thinking', text: 'hmm' }, { type: 'text', text: 'ok' }] })).toEqual([
      { role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] },
    ]);
  });

  it('encodes images as input_image data URLs', () => {
    expect(toResponsesItems({ role: 'user', content: [{ type: 'text', text: 'see' }, { type: 'image', mediaType: 'image/png', data: 'QUJD' }] })).toEqual([
      { role: 'user', content: [{ type: 'input_text', text: 'see' }, { type: 'input_image', image_url: 'data:image/png;base64,QUJD' }] },
    ]);
  });
});

describe('parseResponsesOutput', () => {
  it('maps reasoning, message and function_call items and reports tool_use', () => {
    const r = parseResponsesOutput({
      model: 'gpt-5.1',
      status: 'completed',
      output: [
        reasoningItem,
        { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Let me look.' }] },
        { type: 'function_call', call_id: 'call_9', name: 'read_file', arguments: '{"path":"b.ts"}' },
      ],
      usage: { input_tokens: 120, output_tokens: 30, input_tokens_details: { cached_tokens: 100 } },
    });
    expect(r.stopReason).toBe('tool_use');
    expect(r.content).toEqual([
      { type: 'thinking', text: 'Plan: read the file.', opaque: reasoningItem },
      { type: 'text', text: 'Let me look.' },
      { type: 'tool_use', id: 'call_9', name: 'read_file', input: { path: 'b.ts' } },
    ]);
    // input_tokens (120) includes the 100 cached tokens; the harness reports the fresh 20 apart.
    expect(r.usage).toEqual({ inputTokens: 20, outputTokens: 30, cacheReadTokens: 100 });
  });

  it('reports max_tokens when the response was cut off', () => {
    const r = parseResponsesOutput({ model: 'm', status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output: [] });
    expect(r.stopReason).toBe('max_tokens');
  });
});

function sse(events: Array<Record<string, unknown>>): Response {
  const text = events.map((e) => `event: ${String(e.type)}\ndata: ${JSON.stringify(e)}`).join('\n\n') + '\n\n';
  return new Response(text);
}

async function collect(events: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const e of events) out.push(e);
  return out;
}

describe('streamResponses', () => {
  it('maps the stream to thinking, text and tool-use events and ends with the parsed response', async () => {
    const final = {
      model: 'gpt-5.1',
      status: 'completed',
      output: [
        reasoningItem,
        { type: 'function_call', call_id: 'call_1', name: 'read_file', arguments: '{"path":"a.ts"}' },
      ],
      usage: { input_tokens: 10, output_tokens: 5 },
    };
    const events = await collect(
      streamResponses(
        sse([
          { type: 'response.created', response: { model: 'gpt-5.1', output: [] } },
          { type: 'response.reasoning_summary_text.delta', delta: 'Plan: ' },
          { type: 'response.reasoning_summary_text.delta', delta: 'read the file.' },
          { type: 'response.output_text.delta', delta: 'Let me ' },
          { type: 'response.output_text.delta', delta: 'look.' },
          { type: 'response.output_item.added', item: { type: 'function_call', call_id: 'call_1', name: 'read_file', arguments: '' } },
          { type: 'response.function_call_arguments.delta', delta: '{"path":' },
          { type: 'response.function_call_arguments.delta', delta: '"a.ts"}' },
          { type: 'response.function_call_arguments.done', arguments: '{"path":"a.ts"}' },
          { type: 'response.completed', response: final },
        ]),
        'gpt-5.1',
      ),
    );
    expect(events.map((e) => e.type)).toEqual([
      'thinking_delta',
      'thinking_delta',
      'text_delta',
      'text_delta',
      'tool_use_start',
      'tool_use_delta',
      'tool_use_delta',
      'tool_use_stop',
      'message_stop',
    ]);
    const stop = events[events.length - 1]!;
    if (stop.type === 'message_stop') {
      expect(stop.response.stopReason).toBe('tool_use');
      expect(stop.response.content[0]).toMatchObject({ type: 'thinking', opaque: reasoningItem });
      expect(stop.response.content[1]).toMatchObject({ type: 'tool_use', id: 'call_1', input: { path: 'a.ts' } });
    }
  });

  it('throws on a failed response', async () => {
    await expect(collect(streamResponses(sse([{ type: 'response.failed', response: { model: 'm', output: [] }, error: { message: 'boom' } }]), 'm'))).rejects.toThrow(/boom/);
  });
});

describe('OpenAIProvider', () => {
  let spy: ReturnType<typeof vi.spyOn> | null = null;
  afterEach(() => {
    spy?.mockRestore();
    delete process.env.AUTOCODE_OPENAI_CHAT_COMPLETIONS;
  });

  it('posts to /responses with a stateless body and the bearer key', async () => {
    spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ model: 'gpt-5.1', status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] }], usage: { input_tokens: 1, output_tokens: 1 } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const p = new OpenAIProvider({ kind: 'byok', apiKey: 'k' });
    const r = await p.complete({ ...baseReq, thinking: { mode: 'effort', effort: 'medium', summary: true } });
    expect(r.content).toEqual([{ type: 'text', text: 'ok' }]);
    const [url, init] = spy.mock.calls[0]! as [string, RequestInit];
    expect(url).toBe('https://api.openai.com/v1/responses');
    expect((init.headers as Record<string, string>)['authorization']).toBe('Bearer k');
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body.store).toBe(false);
    expect(body.reasoning).toEqual({ effort: 'medium', summary: 'auto' });
  });

  it('falls back to /chat/completions when AUTOCODE_OPENAI_CHAT_COMPLETIONS=1', async () => {
    process.env.AUTOCODE_OPENAI_CHAT_COMPLETIONS = '1';
    spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ id: 'x', model: 'gpt-5.1', choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'ok' } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const p = new OpenAIProvider({ kind: 'byok', apiKey: 'k' });
    await p.complete(baseReq);
    expect((spy.mock.calls[0]! as [string])[0]).toBe('https://api.openai.com/v1/chat/completions');
  });
});
