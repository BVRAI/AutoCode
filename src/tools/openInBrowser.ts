import { spawn } from 'node:child_process';
import { isAutomaxHosted, emitHostSignal, osOpenCommand } from '../util/host.js';
import {
  optionalString,
  type Tool,
  type ToolDefinition,
  type ToolExecutionContext,
  type ToolResult,
} from './types.js';

const MAX_STANDALONE_URLS = 5;

const DEFINITION: ToolDefinition = {
  name: 'open_in_browser',
  description:
    'Open one or more URLs in the user\'s web browser — for example, the source pages from a web_search. ' +
    'Use this when the user asks to see, open, or visit sources or a page. ' +
    'When autocode runs inside Automax, the URLs open in the Automax browser workspace instead. ' +
    'Only http/https URLs are allowed.',
  inputSchema: {
    type: 'object',
    properties: {
      urls: { type: 'array', items: { type: 'string' }, description: 'URLs to open.' },
      url: { type: 'string', description: 'A single URL to open (alternative to urls).' },
    },
  },
};

export class OpenInBrowserTool implements Tool {
  readonly definition = DEFINITION;

  async execute(args: Record<string, unknown>, _ctx: ToolExecutionContext): Promise<ToolResult> {
    const raw: string[] = [];
    if (Array.isArray(args.urls)) {
      for (const u of args.urls) if (typeof u === 'string') raw.push(u);
    }
    const single = optionalString(args, 'url');
    if (single) raw.push(single);
    if (raw.length === 0) {
      return { summary: 'no urls', content: 'Provide a `urls` array or a `url` string.', isError: true };
    }

    const valid: string[] = [];
    for (const u of raw) {
      try {
        const parsed = new URL(u);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
          return {
            summary: 'bad protocol',
            content: `Refused ${u} — only http/https URLs can be opened.`,
            isError: true,
          };
        }
        valid.push(parsed.toString());
      } catch {
        return { summary: 'bad url', content: `invalid URL: ${u}`, isError: true };
      }
    }

    if (isAutomaxHosted()) {
      emitHostSignal('open_browser', { urls: valid });
      return {
        summary: `signalled Automax to open ${valid.length} url${valid.length === 1 ? '' : 's'}`,
        content: `Sent ${valid.length} URL(s) to the Automax browser workspace:\n${valid.join('\n')}`,
        metadata: { hosted: true, urls: valid },
      };
    }

    const toOpen = valid.slice(0, MAX_STANDALONE_URLS);
    for (const u of toOpen) {
      const { cmd, args: cmdArgs } = osOpenCommand(u);
      try {
        const child = spawn(cmd, [...cmdArgs], { detached: true, stdio: 'ignore' });
        child.unref();
      } catch (e) {
        return {
          summary: 'open failed',
          content: `Failed to open ${u}: ${e instanceof Error ? e.message : String(e)}`,
          isError: true,
        };
      }
    }
    const truncated = valid.length > toOpen.length;
    return {
      summary: `opened ${toOpen.length} url${toOpen.length === 1 ? '' : 's'} in the default browser`,
      content:
        `Opened in the default browser:\n${toOpen.join('\n')}` +
        (truncated ? `\n(${valid.length - toOpen.length} more not opened — capped at ${MAX_STANDALONE_URLS})` : ''),
      metadata: { hosted: false, urls: toOpen },
    };
  }
}
