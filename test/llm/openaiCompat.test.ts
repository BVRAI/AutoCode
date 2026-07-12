import { describe, it, expect } from 'vitest';
import {
  buildBody,
  isOpenAiReasoningModel,
  parseResponse,
  streamOpenAiCompat,
  type OpenAiChatResponse,
} from '../../src/llm/providers/openaiCompat.js';
import type { CompletionRequest, StreamEvent } from '../../src/llm/types.js';

const baseReq: CompletionRequest = {
  model: 'grok-code-fast-1',
  system: 'you are autocode',
  messages: [{ role: 'user', content: 'list the files' }],
  tools: [
    {
      name: 'list_directory',
      description: 'list',
      inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    },
  ],
};

describe('openaiCompat.buildBody', () => {
  it('puts system prompt as the first message', () => {
    const body = buildBody(baseReq);
    expect(body.messages[0]).toEqual({ role: 'system', content: 'you are autocode' });
    expect(body.messages[1]).toEqual({ role: 'user', content: 'list the files' });
  });

  it('translates tools into the function-calling shape', () => {
    const body = buildBody(baseReq);
    expect(body.tools).toEqual([
      {
        type: 'function',
        function: {
          name: 'list_directory',
          description: 'list',
          parameters: baseReq.tools[0]!.inputSchema,
        },
      },
    ]);
    expect(body.tool_choice).toBe('auto');
  });

  it('translates assistant tool_use blocks into tool_calls with string args', () => {
    const body = buildBody({
      ...baseReq,
      messages: [
        { role: 'user', content: 'list' },
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'sure, listing now' },
            { type: 'tool_use', id: 'call_1', name: 'list_directory', input: { path: '.' } },
          ],
        },
      ],
    });
    const asst = body.messages[2]!;
    expect(asst.role).toBe('assistant');
    expect(asst.content).toBe('sure, listing now');
    expect(asst.tool_calls).toEqual([
      {
        id: 'call_1',
        type: 'function',
        function: { name: 'list_directory', arguments: JSON.stringify({ path: '.' }) },
      },
    ]);
  });

  // ── OpenAI reasoning-model parameter handling ────────────────────────

  it('uses max_tokens + temperature for standard chat models (gpt-5.1)', () => {
    const body = buildBody({ ...baseReq, model: 'gpt-5.1' });
    expect(body.max_tokens).toBe(8192);
    expect(body.temperature).toBe(1);
    expect(body.max_completion_tokens).toBeUndefined();
  });

  it('uses max_completion_tokens + omits temperature for o4-mini (reasoning)', () => {
    const body = buildBody({ ...baseReq, model: 'o4-mini' });
    expect(body.max_completion_tokens).toBe(8192);
    expect(body.max_tokens).toBeUndefined();
    expect(body.temperature).toBeUndefined();
  });

  it('matches the OpenRouter-prefixed reasoning variant (openai/o4-mini)', () => {
    const body = buildBody({ ...baseReq, model: 'openai/o4-mini' });
    expect(body.max_completion_tokens).toBe(8192);
    expect(body.max_tokens).toBeUndefined();
    expect(body.temperature).toBeUndefined();
  });

  it('preserves max_tokens + temperature for grok-code-fast-1 (regression guard)', () => {
    const body = buildBody({ ...baseReq, model: 'grok-code-fast-1' });
    expect(body.max_tokens).toBe(8192);
    expect(body.temperature).toBe(1);
    expect(body.max_completion_tokens).toBeUndefined();
  });

  it('matches older reasoning models (o1-preview, o3-mini, o3-pro)', () => {
    for (const model of ['o1', 'o1-mini', 'o1-preview', 'o3', 'o3-mini', 'o3-pro']) {
      const body = buildBody({ ...baseReq, model });
      expect(body.max_completion_tokens, `${model} should use max_completion_tokens`).toBe(8192);
      expect(body.max_tokens, `${model} should NOT set max_tokens`).toBeUndefined();
      expect(body.temperature, `${model} should NOT set temperature`).toBeUndefined();
    }
  });

  it('honors a user-supplied maxTokens on reasoning models', () => {
    const body = buildBody({ ...baseReq, model: 'o4-mini', maxTokens: 4096 });
    expect(body.max_completion_tokens).toBe(4096);
  });

  it('translates tool_result blocks into role:tool messages', () => {
    const body = buildBody({
      ...baseReq,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'tool_result', toolUseId: 'call_1', content: 'a.txt\nb.md', isError: false },
          ],
        },
      ],
    });
    expect(body.messages[1]).toEqual({
      role: 'tool',
      content: 'a.txt\nb.md',
      tool_call_id: 'call_1',
    });
  });
});

describe('isOpenAiReasoningModel', () => {
  it('matches the OpenAI o-series and its OpenRouter prefix', () => {
    for (const m of ['o1', 'o1-mini', 'o1-preview', 'o3', 'o3-mini', 'o3-pro', 'o4', 'o4-mini', 'openai/o4-mini', 'o5-future']) {
      expect(isOpenAiReasoningModel(m), m).toBe(true);
    }
  });
  it('does NOT match standard or non-OpenAI models', () => {
    for (const m of ['gpt-5.1', 'gpt-5', 'gpt-4.1', 'grok-code-fast-1', 'grok-4', 'claude-opus-4-7', 'claude-sonnet-4-6', 'gemini-2.5-flash', 'meta-llama/llama-3.3-70b', 'anthropic/claude-opus-4-7']) {
      expect(isOpenAiReasoningModel(m), m).toBe(false);
    }
  });
});

describe('openaiCompat.parseResponse', () => {
  it('parses a text-only response into a single text block', () => {
    const resp: OpenAiChatResponse = {
      id: 'r1',
      model: 'grok-code-fast-1',
      choices: [
        {
          index: 0,
          finish_reason: 'stop',
          message: { role: 'assistant', content: 'all done' },
        },
      ],
      usage: { prompt_tokens: 100, completion_tokens: 5, total_tokens: 105 },
    };
    const parsed = parseResponse(resp);
    expect(parsed.stopReason).toBe('end_turn');
    expect(parsed.content).toEqual([{ type: 'text', text: 'all done' }]);
    expect(parsed.usage.inputTokens).toBe(100);
  });

  it('parses tool_calls into tool_use blocks with JSON-decoded input', () => {
    const resp: OpenAiChatResponse = {
      id: 'r2',
      model: 'grok-code-fast-1',
      choices: [
        {
          index: 0,
          finish_reason: 'tool_calls',
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'call_42',
                type: 'function',
                function: { name: 'read_file', arguments: '{"path":"src/a.ts"}' },
              },
            ],
          },
        },
      ],
      usage: { prompt_tokens: 100, completion_tokens: 5, total_tokens: 105 },
    };
    const parsed = parseResponse(resp);
    expect(parsed.stopReason).toBe('tool_use');
    expect(parsed.content).toEqual([
      { type: 'tool_use', id: 'call_42', name: 'read_file', input: { path: 'src/a.ts' } },
    ]);
  });

  it('handles malformed tool_call arguments without throwing', () => {
    const resp: OpenAiChatResponse = {
      id: 'r3',
      model: 'grok-code-fast-1',
      choices: [
        {
          index: 0,
          finish_reason: 'tool_calls',
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'call_bad',
                type: 'function',
                function: { name: 'whatever', arguments: 'not-json' },
              },
            ],
          },
        },
      ],
      usage: { prompt_tokens: 100, completion_tokens: 5, total_tokens: 105 },
    };
    const parsed = parseResponse(resp);
    expect(parsed.content[0]).toMatchObject({ type: 'tool_use', input: { _raw: 'not-json' } });
  });

  it('normalizes finish_reason variants', () => {
    const mk = (reason: string): OpenAiChatResponse => ({
      id: 'x',
      model: 'm',
      choices: [{ index: 0, finish_reason: reason, message: { role: 'assistant', content: 'x' } }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    });
    expect(parseResponse(mk('stop')).stopReason).toBe('end_turn');
    expect(parseResponse(mk('length')).stopReason).toBe('max_tokens');
    expect(parseResponse(mk('tool_calls')).stopReason).toBe('tool_use');
    expect(parseResponse(mk('content_filter')).stopReason).toBe('error');
  });
});

// ── Reasoning/thinking passthrough ─────────────────────────────────────────

// An assistant turn as it sits in history after a reasoning model's tool-use
// step: reasoning first, then text, then the tool call.
const assistantTurnWithThinking: CompletionRequest['messages'] = [
  { role: 'user', content: 'do the thing' },
  {
    role: 'assistant',
    content: [
      { type: 'thinking', text: 'I should check the file first' },
      { type: 'text', text: 'Checking.' },
      { type: 'tool_use', id: 'call_1', name: 'read_file', input: { path: 'a.ts' } },
    ],
  },
  { role: 'user', content: [{ type: 'tool_result', toolUseId: 'call_1', content: 'file body' }] },
];

describe('buildBody reasoning echo', () => {
  it('omits all reasoning fields by default', () => {
    const body = buildBody({ ...baseReq, messages: assistantTurnWithThinking });
    const assistant = body.messages.find((m) => m.role === 'assistant')!;
    expect(assistant.reasoning_content).toBeUndefined();
    expect(assistant.reasoning).toBeUndefined();
    expect(assistant.reasoning_details).toBeUndefined();
  });

  it('echoes reasoning_content on assistant turns in reasoning_content mode', () => {
    const body = buildBody(
      { ...baseReq, messages: assistantTurnWithThinking },
      { reasoningEcho: 'reasoning_content' },
    );
    const assistant = body.messages.find((m) => m.role === 'assistant')!;
    expect(assistant.reasoning_content).toBe('I should check the file first');
    expect(assistant.reasoning_details).toBeUndefined();
  });

  it('echoes reasoning_details verbatim in reasoning_details mode', () => {
    const details = [
      { type: 'reasoning.text', text: 'step one', signature: 'sig-a', id: 'r1', format: 'anthropic', index: 0 },
    ];
    const body = buildBody(
      {
        ...baseReq,
        messages: [
          { role: 'user', content: 'go' },
          { role: 'assistant', content: [{ type: 'thinking', text: 'step one', opaque: details }] },
        ],
      },
      { reasoningEcho: 'reasoning_details' },
    );
    const assistant = body.messages.find((m) => m.role === 'assistant')!;
    expect(assistant.reasoning_details).toEqual(details);
    expect(assistant.reasoning).toBeUndefined();
  });

  it('falls back to the plaintext reasoning field when no opaque payload exists', () => {
    const body = buildBody(
      { ...baseReq, messages: assistantTurnWithThinking },
      { reasoningEcho: 'reasoning_details' },
    );
    const assistant = body.messages.find((m) => m.role === 'assistant')!;
    expect(assistant.reasoning).toBe('I should check the file first');
    expect(assistant.reasoning_details).toBeUndefined();
  });
});

describe('parseResponse reasoning extraction', () => {
  const mkResp = (): OpenAiChatResponse => ({
    id: 'r',
    model: 'grok-code-fast-1',
    choices: [
      { index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'the answer' } },
    ],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  });

  it('parses message.reasoning_content into a leading thinking block', () => {
    const json = mkResp();
    json.choices[0]!.message.reasoning_content = 'thought hard';
    const resp = parseResponse(json);
    expect(resp.content[0]).toEqual({ type: 'thinking', text: 'thought hard' });
    expect(resp.content[1]).toEqual({ type: 'text', text: 'the answer' });
  });

  it('keeps reasoning_details losslessly in opaque', () => {
    const json = mkResp();
    const details = [{ type: 'reasoning.encrypted', data: 'blob', index: 0 }];
    json.choices[0]!.message.reasoning = 'summary';
    json.choices[0]!.message.reasoning_details = details;
    const resp = parseResponse(json);
    expect(resp.content[0]).toEqual({ type: 'thinking', text: 'summary', opaque: details });
  });

  it('emits no thinking block when the response has no reasoning', () => {
    const resp = parseResponse(mkResp());
    expect(resp.content[0]).toEqual({ type: 'text', text: 'the answer' });
  });
});

function sse(...payloads: unknown[]): Response {
  const text =
    payloads.map((p) => `data: ${typeof p === 'string' ? p : JSON.stringify(p)}`).join('\n\n') +
    '\n\n';
  return new Response(text);
}

async function collect(events: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const e of events) out.push(e);
  return out;
}

describe('streamOpenAiCompat reasoning', () => {
  it('emits thinking_delta for delta.reasoning_content and folds a thinking block into message_stop', async () => {
    const events = await collect(
      streamOpenAiCompat(
        sse(
          { choices: [{ delta: { reasoning_content: 'let me ' } }] },
          { choices: [{ delta: { reasoning_content: 'think' } }] },
          { choices: [{ delta: { content: 'done' }, finish_reason: 'stop' }] },
          '[DONE]',
        ),
        'grok-code-fast-1',
      ),
    );
    const thinkingDeltas = events.filter((e) => e.type === 'thinking_delta');
    expect(thinkingDeltas.map((e) => (e.type === 'thinking_delta' ? e.text : ''))).toEqual([
      'let me ',
      'think',
    ]);
    const stop = events.at(-1)!;
    expect(stop.type).toBe('message_stop');
    if (stop.type === 'message_stop') {
      expect(stop.response.content[0]).toEqual({ type: 'thinking', text: 'let me think' });
      expect(stop.response.content[1]).toEqual({ type: 'text', text: 'done' });
    }
  });

  it('merges delta.reasoning_details across chunks by index', async () => {
    const events = await collect(
      streamOpenAiCompat(
        sse(
          { choices: [{ delta: { reasoning: 'a', reasoning_details: [{ index: 0, type: 'reasoning.text', text: 'a' }] } }] },
          { choices: [{ delta: { reasoning: 'b', reasoning_details: [{ index: 0, text: 'b', signature: 'sig-final' }] } }] },
          { choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] },
          '[DONE]',
        ),
        'anthropic/claude-sonnet-4-5',
      ),
    );
    const stop = events.at(-1)!;
    expect(stop.type).toBe('message_stop');
    if (stop.type === 'message_stop') {
      const thinking = stop.response.content[0]!;
      expect(thinking).toMatchObject({ type: 'thinking', text: 'ab' });
      expect((thinking as { opaque?: unknown[] }).opaque).toEqual([
        { index: 0, type: 'reasoning.text', text: 'ab', signature: 'sig-final' },
      ]);
    }
  });

  it('interleaves reasoning with tool_call deltas', async () => {
    const events = await collect(
      streamOpenAiCompat(
        sse(
          { choices: [{ delta: { reasoning_content: 'plan' } }] },
          { choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'grep', arguments: '{"q":' } }] } }] },
          { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"x"}' } }] }, finish_reason: 'tool_calls' }] },
          '[DONE]',
        ),
        'grok-code-fast-1',
      ),
    );
    expect(events.some((e) => e.type === 'thinking_delta')).toBe(true);
    expect(events.some((e) => e.type === 'tool_use_start')).toBe(true);
    const stop = events.at(-1)!;
    if (stop.type === 'message_stop') {
      expect(stop.response.content[0]).toEqual({ type: 'thinking', text: 'plan' });
      expect(stop.response.content[1]).toEqual({
        type: 'tool_use',
        id: 'c1',
        name: 'grep',
        input: { q: 'x' },
      });
      expect(stop.response.stopReason).toBe('tool_use');
    }
  });
});
