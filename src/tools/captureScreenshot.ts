import { isAutomaxHosted, requestHostResult } from '../util/host.js';
import {
  optionalBoolean,
  requireString,
  type Tool,
  type ToolDefinition,
  type ToolExecutionContext,
  type ToolResult,
} from './types.js';
import type { ImageBlock } from '../llm/types.js';

const DEFINITION: ToolDefinition = {
  name: 'capture_screenshot',
  description:
    "Capture a screenshot of a URL (typically the local dev server) using Automax's built-in " +
    'browser, and see the result as an image. Use it to visually check a website you are building ' +
    'and iterate on it. Only available when autocode runs inside Automax.',
  inputSchema: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'The URL to screenshot (e.g. http://localhost:5173).' },
      scroll: { type: 'boolean', description: 'Capture the full scrollable page rather than just the viewport.' },
    },
    required: ['url'],
  },
};

export class CaptureScreenshotTool implements Tool {
  readonly definition = DEFINITION;

  async execute(args: Record<string, unknown>, _ctx: ToolExecutionContext): Promise<ToolResult> {
    const url = requireString(args, 'url');
    const scroll = optionalBoolean(args, 'scroll') ?? false;
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return { summary: 'bad protocol', content: 'Only http/https URLs can be captured.', isError: true };
      }
    } catch {
      return { summary: 'bad url', content: `invalid URL: ${url}`, isError: true };
    }

    if (!isAutomaxHosted()) {
      return {
        summary: 'unavailable',
        content:
          'capture_screenshot needs the Automax host to provide a browser — it is unavailable in ' +
          'standalone autocode. Ask the user to view the page, or start the dev server and describe it.',
        isError: true,
      };
    }

    const result = await requestHostResult('screenshot', { url, scroll });
    if (!result) {
      return { summary: 'no response', content: 'The Automax host did not return a screenshot in time.', isError: true };
    }
    if (result.ok === false) {
      return { summary: 'screenshot failed', content: String(result.error ?? 'screenshot failed'), isError: true };
    }
    const data = result.data;
    if (typeof data !== 'string' || data.length === 0) {
      return { summary: 'bad result', content: 'The host returned no image data.', isError: true };
    }
    const image: ImageBlock = {
      type: 'image',
      mediaType: typeof result.mediaType === 'string' ? result.mediaType : 'image/png',
      data,
    };
    return {
      summary: `captured screenshot of ${url}`,
      content: `Screenshot of ${url} captured — attached as an image for review.`,
      metadata: { image },
    };
  }
}
