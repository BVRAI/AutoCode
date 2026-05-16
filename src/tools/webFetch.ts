import {
  optionalNumber,
  requireString,
  type Tool,
  type ToolDefinition,
  type ToolExecutionContext,
  type ToolResult,
} from './types.js';

const DEFAULT_MAX_BYTES = 100_000;
const DEFAULT_TIMEOUT_MS = 20_000;

const DEFINITION: ToolDefinition = {
  name: 'web_fetch',
  description:
    'Fetch a URL and return its text content. HTML is converted to plain text. ' +
    'Use this to read public documentation, GitHub READMEs, blog posts, or any URL the user mentions. ' +
    'Do not use for authenticated or paginated APIs.',
  inputSchema: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'Fully-qualified URL (http or https).' },
      max_bytes: { type: 'number', description: `Cap output. Default ${DEFAULT_MAX_BYTES}.` },
    },
    required: ['url'],
  },
};

export class WebFetchTool implements Tool {
  readonly definition = DEFINITION;

  async execute(args: Record<string, unknown>, _ctx: ToolExecutionContext): Promise<ToolResult> {
    const url = requireString(args, 'url');
    const maxBytes = optionalNumber(args, 'max_bytes') ?? DEFAULT_MAX_BYTES;
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return { summary: 'bad url', content: `invalid URL: ${url}`, isError: true };
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return { summary: 'bad protocol', content: `only http/https supported`, isError: true };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
    try {
      const res = await fetch(parsed, {
        signal: controller.signal,
        headers: { 'user-agent': 'autocode/0.1 (+https://github.com/gregpalin/autocode)' },
        redirect: 'follow',
      });
      const ct = res.headers.get('content-type') ?? '';
      const raw = await res.text();
      const cleaned = ct.includes('html') ? htmlToText(raw) : raw;
      const truncated = cleaned.length > maxBytes;
      const body = truncated ? cleaned.slice(0, maxBytes) + '\n… truncated' : cleaned;
      return {
        summary: `${res.status} ${ct.split(';')[0]} ${parsed.host} (${cleaned.length} bytes${truncated ? ', truncated' : ''})`,
        content: body,
        isError: !res.ok,
        metadata: { status: res.status, contentType: ct, bytes: cleaned.length, truncated },
      };
    } catch (e) {
      return {
        summary: 'fetch failed',
        content: e instanceof Error ? e.message : String(e),
        isError: true,
      };
    } finally {
      clearTimeout(timer);
    }
  }
}

// Cheap HTML → text. Drops script/style, unwraps tags, collapses whitespace.
function htmlToText(html: string): string {
  let s = html;
  s = s.replace(/<script[\s\S]*?<\/script>/gi, '');
  s = s.replace(/<style[\s\S]*?<\/style>/gi, '');
  s = s.replace(/<!--[\s\S]*?-->/g, '');
  s = s.replace(/<\/?(p|div|br|h[1-6]|li|tr|section|article)[^>]*>/gi, '\n');
  s = s.replace(/<[^>]+>/g, '');
  s = s.replace(/&nbsp;/g, ' ');
  s = s.replace(/&amp;/g, '&');
  s = s.replace(/&lt;/g, '<');
  s = s.replace(/&gt;/g, '>');
  s = s.replace(/&quot;/g, '"');
  s = s.replace(/&#(\d+);/g, (_, n: string) => String.fromCharCode(parseInt(n, 10)));
  s = s.replace(/[ \t]+/g, ' ');
  s = s.replace(/\n\s*\n+/g, '\n\n');
  return s.trim();
}
