import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { WebSearchTool } from '../../src/tools/webSearch.js';
import type { ToolExecutionContext } from '../../src/tools/types.js';
import type { SessionContext } from '../../src/session/SessionContext.js';

function ctxFor(provider: string): ToolExecutionContext {
  const session: SessionContext = {
    sessionId: 't',
    projectRoot: '/tmp',
    dataDir: '/tmp',
    sessionDir: '/tmp/s',
    model: { provider, model: 'grok-code-fast-1' },
    startedAt: new Date().toISOString(),
  };
  return { session };
}

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

function htmlResponse(html: string): Response {
  return { ok: true, status: 200, text: async () => html } as unknown as Response;
}

// One DuckDuckGo result row, matching the tool's scraping regex.
const DDG_HTML =
  '<a class="result__a" href="https://ddg.example/page">DDG Title</a>' +
  '<a class="result__snippet">a snippet</a>';

describe('web_search backend selection', () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    vi.stubEnv('BRAVE_API_KEY', '');
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('uses the Grok/xAI backend when provider is xai and auth resolves', async () => {
    vi.stubEnv('AUTOMAX_PROXY_TOKEN', 'tok'); // makes AuthResolver resolve to automax
    // Mirrors the real xAI Responses API shape: a `message` item whose
    // output_text content carries `url_citation` annotations.
    const fetchMock = vi.fn(async (url: unknown) => {
      expect(String(url)).toContain('/responses');
      return jsonResponse({
        output: [
          { type: 'web_search_call', action: { type: 'search', query: 'latest typescript' } },
          {
            type: 'message',
            content: [
              {
                type: 'output_text',
                text: 'TypeScript 5.9 is the latest stable release.',
                annotations: [
                  { type: 'url_citation', url: 'https://www.typescriptlang.org/', title: '1' },
                  { type: 'url_citation', url: 'https://github.com/microsoft/TypeScript', title: '2' },
                ],
              },
            ],
          },
        ],
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const out = await new WebSearchTool().execute({ query: 'latest typescript' }, ctxFor('xai'));
    expect(out.isError).toBeFalsy();
    expect(out.metadata?.provider).toBe('xai');
    expect(out.content).toContain('TypeScript 5.9');
    expect(out.content).toContain('https://www.typescriptlang.org/');
    expect(out.metadata?.citations).toEqual([
      'https://www.typescriptlang.org/',
      'https://github.com/microsoft/TypeScript',
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('falls back to DuckDuckGo when the xAI backend errors', async () => {
    vi.stubEnv('AUTOMAX_PROXY_TOKEN', 'tok');
    const fetchMock = vi.fn(async (url: unknown) => {
      if (String(url).includes('/responses')) return jsonResponse({ error: 'boom' }, false, 500);
      return htmlResponse(DDG_HTML);
    });
    vi.stubGlobal('fetch', fetchMock);

    const out = await new WebSearchTool().execute({ query: 'anything' }, ctxFor('xai'));
    expect(out.isError).toBeFalsy();
    expect(out.metadata?.provider).toBe('duckduckgo');
    expect(out.content).toContain('DDG Title');
  });

  it('uses Brave when BRAVE_API_KEY is set and provider is not xai', async () => {
    vi.stubEnv('BRAVE_API_KEY', 'brave-key');
    const fetchMock = vi.fn(async (url: unknown) => {
      expect(String(url)).toContain('api.search.brave.com');
      return jsonResponse({
        web: { results: [{ title: 'Brave Hit', url: 'https://brave.example/x', description: 'desc' }] },
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const out = await new WebSearchTool().execute({ query: 'q' }, ctxFor('anthropic'));
    expect(out.metadata?.provider).toBe('brave');
    expect(out.metadata?.citations).toEqual(['https://brave.example/x']);
  });

  it('falls back to DuckDuckGo when there is no key and provider is not xai', async () => {
    const fetchMock = vi.fn(async () => htmlResponse(DDG_HTML));
    vi.stubGlobal('fetch', fetchMock);

    const out = await new WebSearchTool().execute({ query: 'q' }, ctxFor('openai'));
    expect(out.metadata?.provider).toBe('duckduckgo');
    expect(out.metadata?.citations).toEqual(['https://ddg.example/page']);
  });
});
