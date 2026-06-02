import { AuthResolver, isProxyAuth, type AuthMode } from '../auth/AuthResolver.js';
import {
  optionalNumber,
  requireString,
  type Tool,
  type ToolDefinition,
  type ToolExecutionContext,
  type ToolResult,
} from './types.js';

const DEFAULT_LIMIT = 8;
const DEFAULT_TIMEOUT_MS = 15_000;
// Grok web search runs a full model call plus live searching — much slower
// than a plain Brave/DDG query, so it gets a longer timeout.
const XAI_SEARCH_TIMEOUT_MS = 60_000;
const XAI_DEFAULT_BASE = 'https://api.x.ai/v1';

const DEFINITION: ToolDefinition = {
  name: 'web_search',
  description:
    'Search the web for a query and return results with their source URLs. ' +
    'When running on xAI, uses Grok web search; otherwise Brave Search (if BRAVE_API_KEY) or DuckDuckGo. ' +
    'Use this to find docs, libraries, or current information not on disk. ' +
    'The source URLs in the result can be passed to open_in_browser.',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Search query.' },
      limit: { type: 'number', description: `Max results. Default ${DEFAULT_LIMIT}.` },
    },
    required: ['query'],
  },
};

export class WebSearchTool implements Tool {
  readonly definition = DEFINITION;

  async execute(args: Record<string, unknown>, ctx: ToolExecutionContext): Promise<ToolResult> {
    const query = requireString(args, 'query');
    const limit = optionalNumber(args, 'limit') ?? DEFAULT_LIMIT;

    // Backend order: Grok web search (when on xAI with auth) → Brave → DuckDuckGo.
    if (ctx.session.model.provider === 'xai') {
      const auth = new AuthResolver().resolve('xai');
      if (auth.kind !== 'missing') {
        try {
          return await xaiSearch(query, ctx.session.model.model, auth);
        } catch (e) {
          // Never hard-fail a search — fall through to the keyless backend.
          process.stderr.write(
            `(web_search: xai backend failed, falling back to DuckDuckGo: ${e instanceof Error ? e.message : String(e)})\n`,
          );
        }
      }
    }

    const braveKey = process.env.BRAVE_API_KEY;
    try {
      const results = braveKey
        ? await braveSearch(query, limit, braveKey)
        : await duckDuckGoSearch(query, limit);
      if (results.length === 0) {
        return { summary: `0 results for ${query}`, content: '(no results)' };
      }
      const content = results
        .map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`)
        .join('\n\n');
      return {
        summary: `${results.length} results for "${query}" via ${braveKey ? 'Brave' : 'DuckDuckGo'}`,
        content,
        metadata: {
          provider: braveKey ? 'brave' : 'duckduckgo',
          count: results.length,
          citations: results.map((r) => r.url).filter((u) => u.length > 0),
        },
      };
    } catch (e) {
      return {
        summary: 'search failed',
        content: e instanceof Error ? e.message : String(e),
        isError: true,
      };
    }
  }
}

// Grok web search via xAI's Responses API. The server-side `web_search` tool
// returns a synthesized answer plus source citations. Billed per source used.
async function xaiSearch(
  query: string,
  model: string,
  auth: Exclude<AuthMode, { kind: 'missing' }>,
): Promise<ToolResult> {
  const base = isProxyAuth(auth) ? auth.baseOverride : XAI_DEFAULT_BASE;
  const token = isProxyAuth(auth) ? auth.token : auth.apiKey;
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), XAI_SEARCH_TIMEOUT_MS);
  try {
    const res = await fetch(`${base}/responses`, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ model, input: query, tools: [{ type: 'web_search' }] }),
    });
    if (!res.ok) throw new Error(`xai ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const json = (await res.json()) as Record<string, unknown>;
    const text = extractResponsesText(json);
    const citations = extractCitations(json);
    if (!text && citations.length === 0) throw new Error('no text or citations in xai response');
    const sources = citations.length > 0 ? `\n\nSources:\n${citations.map((u) => `- ${u}`).join('\n')}` : '';
    return {
      summary: `web search for "${query}" via Grok (${citations.length} source${citations.length === 1 ? '' : 's'})`,
      content: (text || '(no summary returned)') + sources,
      metadata: { provider: 'xai', citations },
    };
  } finally {
    clearTimeout(t);
  }
}

// xAI Responses API: the final answer is the `output_text` content of the
// `message`-typed item in the `output` array.
function extractResponsesText(json: Record<string, unknown>): string {
  if (typeof json.output_text === 'string') return json.output_text.trim();
  const output = json.output;
  if (Array.isArray(output)) {
    const parts: string[] = [];
    for (const item of output) {
      if ((item as { type?: string }).type !== 'message') continue;
      const content = (item as { content?: unknown }).content;
      if (Array.isArray(content)) {
        for (const c of content) {
          const tx = (c as { text?: unknown }).text;
          if (typeof tx === 'string') parts.push(tx);
        }
      }
    }
    if (parts.length > 0) return parts.join('\n').trim();
  }
  return '';
}

// xAI Responses API: source URLs are `url_citation` annotations on the
// message's output_text content. Falls back to a top-level `citations`
// array if a future API version provides one.
function extractCitations(json: Record<string, unknown>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const add = (u: unknown): void => {
    if (typeof u === 'string' && u.length > 0 && !seen.has(u)) {
      seen.add(u);
      out.push(u);
    }
  };
  const output = json.output;
  if (Array.isArray(output)) {
    for (const item of output) {
      const content = (item as { content?: unknown }).content;
      if (!Array.isArray(content)) continue;
      for (const c of content) {
        const anns = (c as { annotations?: unknown }).annotations;
        if (!Array.isArray(anns)) continue;
        for (const a of anns) {
          if (a && typeof a === 'object' && (a as { type?: string }).type === 'url_citation') {
            add((a as { url?: unknown }).url);
          }
        }
      }
    }
  }
  if (out.length === 0 && Array.isArray(json.citations)) {
    for (const c of json.citations) {
      if (typeof c === 'string') add(c);
      else if (c && typeof c === 'object') add((c as { url?: unknown }).url);
    }
  }
  return out;
}

interface SearchHit {
  title: string;
  url: string;
  snippet: string;
}

async function braveSearch(query: string, limit: number, key: string): Promise<SearchHit[]> {
  const url = new URL('https://api.search.brave.com/res/v1/web/search');
  url.searchParams.set('q', query);
  url.searchParams.set('count', String(limit));
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        accept: 'application/json',
        'X-Subscription-Token': key,
      },
    });
    if (!res.ok) throw new Error(`brave ${res.status}`);
    const json = (await res.json()) as {
      web?: { results?: Array<{ title?: string; url?: string; description?: string }> };
    };
    const arr = json.web?.results ?? [];
    return arr.slice(0, limit).map((r) => ({
      title: r.title ?? '(no title)',
      url: r.url ?? '',
      snippet: stripTags(r.description ?? ''),
    }));
  } finally {
    clearTimeout(t);
  }
}

// Parses DuckDuckGo's HTML SERP. Best-effort; if DDG changes layout the JSON-API form should be added.
async function duckDuckGoSearch(query: string, limit: number): Promise<SearchHit[]> {
  const url = new URL('https://html.duckduckgo.com/html/');
  url.searchParams.set('q', query);
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'user-agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) autocode/0.1',
      },
    });
    if (!res.ok) throw new Error(`duckduckgo ${res.status}`);
    const html = await res.text();
    const out: SearchHit[] = [];
    const resultRegex =
      /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
    let m: RegExpExecArray | null;
    while ((m = resultRegex.exec(html)) !== null && out.length < limit) {
      out.push({
        title: stripTags(m[2] ?? ''),
        url: decodeDdgRedirect(m[1] ?? ''),
        snippet: stripTags(m[3] ?? ''),
      });
    }
    return out;
  } finally {
    clearTimeout(t);
  }
}

function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
}

function decodeDdgRedirect(href: string): string {
  // DuckDuckGo wraps target URLs as /l/?uddg=<encoded>&rut=...
  try {
    const u = new URL(href, 'https://duckduckgo.com');
    const uddg = u.searchParams.get('uddg');
    if (uddg) return decodeURIComponent(uddg);
    return href;
  } catch {
    return href;
  }
}
