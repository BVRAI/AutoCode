import { describe, it, expect } from 'vitest';
import {
  buildBody,
  isOpenAiReasoningModel,
  parseResponse,
  type OpenAiChatResponse,
} from '../../src/llm/providers/openaiCompat.js';
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
