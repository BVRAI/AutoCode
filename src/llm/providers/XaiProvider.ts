import type { CompletionRequest, CompletionResponse, LlmProvider, StreamEvent } from '../types.js';
import { isProxyAuth, type AuthMode } from '../../auth/AuthResolver.js';
import { buildBody, parseResponse, streamOpenAiCompat, type OpenAiChatResponse } from './openaiCompat.js';

const DEFAULT_BASE = 'https://api.x.ai/v1';

// Models that answered 400 to `reasoning_effort` in this process. A catalog
// can flag a Grok as thinking-capable when the model reasons on its own and
// rejects the parameter (grok-build-0.1 did: "Model grok-build-0.1 does not
// support parameter reasoningEffort"); the first request retries without it
// and later requests skip it from the start.
const rejectsReasoningParam = new Set<string>();

/** xAI's complaint about the effort parameter, as opposed to any other 400. */
export function isReasoningParamRejection(status: number, bodyText: string): boolean {
  return status === 400 && /reasoning_?effort/i.test(bodyText) && /not support|unsupported|unrecognized|invalid/i.test(bodyText);
}

function withoutReasoning(req: CompletionRequest): CompletionRequest {
  return { ...req, thinking: undefined };
}

export class XaiProvider implements LlmProvider {
  readonly name = 'xai';

  constructor(private readonly auth: AuthMode) {}

  private headers(accept?: string): Record<string, string> {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (accept) headers['accept'] = accept;
    if (this.auth.kind === 'byok') {
      headers['authorization'] = `Bearer ${this.auth.apiKey}`;
    } else if (isProxyAuth(this.auth)) {
      headers['authorization'] = `Bearer ${this.auth.token}`;
    }
    return headers;
  }

  private url(): string {
    const base = isProxyAuth(this.auth) ? this.auth.baseOverride : DEFAULT_BASE;
    return `${base}/chat/completions`;
  }

  /**
   * POST the request; when the model rejects the effort parameter, remember
   * that and send the same request once more without it.
   */
  private async post(req: CompletionRequest, accept: string | undefined, extra: Record<string, unknown>): Promise<Response> {
    const attempt = rejectsReasoningParam.has(req.model) ? withoutReasoning(req) : req;
    const send = (r: CompletionRequest): Promise<Response> =>
      fetch(this.url(), {
        method: 'POST',
        headers: this.headers(accept),
        // grok models return reasoning_content; echo it back so multi-step tool
        // chains keep the model's train of thought (xAI accepts the echo).
        body: JSON.stringify({ ...buildBody(r, { reasoningEcho: 'reasoning_content', effortStyle: 'xai' }), ...extra }),
        signal: r.signal,
      });
    let res = await send(attempt);
    if (!res.ok) {
      const text = await res.text();
      if (attempt.thinking && isReasoningParamRejection(res.status, text)) {
        rejectsReasoningParam.add(req.model);
        res = await send(withoutReasoning(req));
        if (!res.ok) {
          const again = await res.text();
          throw new Error(`xai ${res.status}: ${again.slice(0, 500)}`);
        }
        return res;
      }
      throw new Error(`xai ${res.status}: ${text.slice(0, 500)}`);
    }
    return res;
  }

  async complete(req: CompletionRequest): Promise<CompletionResponse> {
    if (this.auth.kind === 'missing') {
      throw new Error('xai credentials missing — set XAI_API_KEY or AUTOMAX_PROXY_TOKEN');
    }
    const res = await this.post(req, undefined, {});
    const json = (await res.json()) as OpenAiChatResponse;
    return parseResponse(json);
  }

  async *completeStream(req: CompletionRequest): AsyncIterable<StreamEvent> {
    if (this.auth.kind === 'missing') {
      throw new Error('xai credentials missing — set XAI_API_KEY or AUTOMAX_PROXY_TOKEN');
    }
    const res = await this.post(req, 'text/event-stream', { stream: true, stream_options: { include_usage: true } });
    yield* streamOpenAiCompat(res, req.model);
  }
}

/** Test hook. */
export function resetReasoningParamMemo(): void {
  rejectsReasoningParam.clear();
}
