import type { CompletionRequest, CompletionResponse, LlmProvider } from '../types.js';
import type { AuthMode } from '../../auth/AuthResolver.js';
import { buildBody, parseResponse, type OpenAiChatResponse } from './openaiCompat.js';

const DEFAULT_BASE = 'https://openrouter.ai/api/v1';

export class OpenRouterProvider implements LlmProvider {
  readonly name = 'openrouter';

  constructor(private readonly auth: AuthMode) {}

  async complete(req: CompletionRequest): Promise<CompletionResponse> {
    if (this.auth.kind === 'missing') {
      throw new Error('openrouter credentials missing — set OPENROUTER_API_KEY or AUTOMAX_PROXY_TOKEN');
    }
    const base = this.auth.kind === 'automax' ? this.auth.baseOverride : DEFAULT_BASE;
    const url = `${base}/chat/completions`;

    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'http-referer': 'https://github.com/gregpalin/autocode',
      'x-title': 'autocode',
    };
    if (this.auth.kind === 'byok') {
      headers['authorization'] = `Bearer ${this.auth.apiKey}`;
    } else if (this.auth.kind === 'automax') {
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
      throw new Error(`openrouter ${res.status}: ${text.slice(0, 500)}`);
    }
    const json = (await res.json()) as OpenAiChatResponse;
    return parseResponse(json);
  }
}
