import type { CompletionRequest, CompletionResponse, LlmProvider, StreamEvent } from '../types.js';
import { isProxyAuth, type AuthMode } from '../../auth/AuthResolver.js';
import { buildBody, parseResponse, streamOpenAiCompat, type OpenAiChatResponse } from './openaiCompat.js';

const DEFAULT_BASE = 'https://api.x.ai/v1';

export class XaiProvider implements LlmProvider {
  readonly name = 'xai';

  constructor(private readonly auth: AuthMode) {}

  async complete(req: CompletionRequest): Promise<CompletionResponse> {
    if (this.auth.kind === 'missing') {
      throw new Error('xai credentials missing — set XAI_API_KEY or AUTOMAX_PROXY_TOKEN');
    }
    const base = isProxyAuth(this.auth) ? this.auth.baseOverride : DEFAULT_BASE;
    const url = `${base}/chat/completions`;

    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (this.auth.kind === 'byok') {
      headers['authorization'] = `Bearer ${this.auth.apiKey}`;
    } else if (isProxyAuth(this.auth)) {
      headers['authorization'] = `Bearer ${this.auth.token}`;
    }

    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(buildBody(req)),
      signal: req.signal,
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`xai ${res.status}: ${text.slice(0, 500)}`);
    }
    const json = (await res.json()) as OpenAiChatResponse;
    return parseResponse(json);
  }

  async *completeStream(req: CompletionRequest): AsyncIterable<StreamEvent> {
    if (this.auth.kind === 'missing') {
      throw new Error('xai credentials missing — set XAI_API_KEY or AUTOMAX_PROXY_TOKEN');
    }
    const base = isProxyAuth(this.auth) ? this.auth.baseOverride : DEFAULT_BASE;
    const url = `${base}/chat/completions`;
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'text/event-stream',
    };
    if (this.auth.kind === 'byok') headers['authorization'] = `Bearer ${this.auth.apiKey}`;
    else if (isProxyAuth(this.auth)) headers['authorization'] = `Bearer ${this.auth.token}`;
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ ...buildBody(req), stream: true, stream_options: { include_usage: true } }),
      signal: req.signal,
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`xai ${res.status}: ${text.slice(0, 500)}`);
    }
    yield* streamOpenAiCompat(res, req.model);
  }
}
