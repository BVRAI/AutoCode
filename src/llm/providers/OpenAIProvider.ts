import type { CompletionRequest, CompletionResponse, LlmProvider, StreamEvent } from '../types.js';
import { isProxyAuth, type AuthMode } from '../../auth/AuthResolver.js';
import { buildBody, parseResponse, streamOpenAiCompat, type OpenAiChatResponse } from './openaiCompat.js';
import { buildResponsesBody, parseResponsesOutput, streamResponses, type ResponsesResult } from './openaiResponses.js';

const DEFAULT_BASE = 'https://api.openai.com/v1';

// OpenAI speaks the Responses API (reasoning effort + encrypted reasoning
// items replayed for continuity, stateless with store:false). The Chat
// Completions path stays behind AUTOCODE_OPENAI_CHAT_COMPLETIONS=1 as an
// escape hatch for gateways that lack /responses.
function useChatCompletions(): boolean {
  return process.env.AUTOCODE_OPENAI_CHAT_COMPLETIONS === '1';
}

export class OpenAIProvider implements LlmProvider {
  readonly name = 'openai';

  constructor(private readonly auth: AuthMode) {}

  private endpoint(path: string): { url: string; headers: Record<string, string> } {
    if (this.auth.kind === 'missing') {
      throw new Error('openai credentials missing — set OPENAI_API_KEY or AUTOMAX_PROXY_TOKEN');
    }
    const base = isProxyAuth(this.auth) ? this.auth.baseOverride : DEFAULT_BASE;
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (this.auth.kind === 'byok') headers['authorization'] = `Bearer ${this.auth.apiKey}`;
    else if (isProxyAuth(this.auth)) headers['authorization'] = `Bearer ${this.auth.token}`;
    return { url: `${base}${path}`, headers };
  }

  async complete(req: CompletionRequest): Promise<CompletionResponse> {
    if (useChatCompletions()) return this.completeChat(req);
    const { url, headers } = this.endpoint('/responses');
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(buildResponsesBody(req)),
      signal: req.signal,
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`openai ${res.status}: ${text.slice(0, 500)}`);
    }
    const json = (await res.json()) as ResponsesResult;
    return parseResponsesOutput(json);
  }

  async *completeStream(req: CompletionRequest): AsyncIterable<StreamEvent> {
    if (useChatCompletions()) {
      yield* this.completeStreamChat(req);
      return;
    }
    const { url, headers } = this.endpoint('/responses');
    const res = await fetch(url, {
      method: 'POST',
      headers: { ...headers, accept: 'text/event-stream' },
      body: JSON.stringify({ ...buildResponsesBody(req), stream: true }),
      signal: req.signal,
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`openai ${res.status}: ${text.slice(0, 500)}`);
    }
    yield* streamResponses(res, req.model);
  }

  // ── Chat Completions fallback ─────────────────────────────────────────────

  private async completeChat(req: CompletionRequest): Promise<CompletionResponse> {
    const { url, headers } = this.endpoint('/chat/completions');
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(buildBody(req)),
      signal: req.signal,
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`openai ${res.status}: ${text.slice(0, 500)}`);
    }
    const json = (await res.json()) as OpenAiChatResponse;
    return parseResponse(json);
  }

  private async *completeStreamChat(req: CompletionRequest): AsyncIterable<StreamEvent> {
    const { url, headers } = this.endpoint('/chat/completions');
    const res = await fetch(url, {
      method: 'POST',
      headers: { ...headers, accept: 'text/event-stream' },
      body: JSON.stringify({ ...buildBody(req), stream: true, stream_options: { include_usage: true } }),
      signal: req.signal,
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`openai ${res.status}: ${text.slice(0, 500)}`);
    }
    yield* streamOpenAiCompat(res, req.model);
  }
}
