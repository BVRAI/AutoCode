import { describe, it, expect } from 'vitest';
import { buildBody, parseResponse, type OpenAiChatResponse } from '../../src/llm/providers/openaiCompat.js';
import type { CompletionRequest } from '../../src/llm/types.js';

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
