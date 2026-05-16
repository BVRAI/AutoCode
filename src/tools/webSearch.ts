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

const DEFINITION: ToolDefinition = {
  name: 'web_search',
  description:
    'Search the web for a query and return a list of results (title, url, snippet). ' +
    'Uses Brave Search if BRAVE_API_KEY is set; otherwise falls back to DuckDuckGo HTML (no key). ' +
    'Use this when you need to find docs, libraries, or current information not on disk.',
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

  async execute(args: Record<string, unknown>, _ctx: ToolExecutionContext): Promise<ToolResult> {
    const query = requireString(args, 'query');
    const limit = optionalNumber(args, 'limit') ?? DEFAULT_LIMIT;

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
        metadata: { provider: braveKey ? 'brave' : 'duckduckgo', count: results.length },
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
