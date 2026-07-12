import { isAutomaxHosted, requestHostResult } from '../util/host.js';
import {
  optionalBoolean,
  optionalNumber,
  optionalString,
  requireString,
  type Tool,
  type ToolDefinition,
  type ToolExecutionContext,
  type ToolResult,
} from './types.js';
import type { ImageBlock } from '../llm/types.js';

const MAX_TIMEOUT_MS = 180_000;

const DEFINITION: ToolDefinition = {
  name: 'computer_use_host',
  description:
    'Ask the Automax host to perform one bounded computer-use inspection/action against a visible or ' +
    'isolated app, then return the observed result. This is only available inside the ComputerUse ' +
    'subagent profile; the main coding agent never sees this low-level host bridge.',
  inputSchema: {
    type: 'object',
    properties: {
      goal: {
        type: 'string',
        description:
          'The exact GUI operation or inspection to perform. Include success criteria and what output you need back.',
      },
      target_app: {
        type: 'string',
        description: 'Optional app/window hint, such as Chrome, Edge, Electron app, or Automax.',
      },
      url: {
        type: 'string',
        description: 'Optional URL to open or inspect, usually a local dev server URL.',
      },
      visible: {
        type: 'boolean',
        description:
          'Optional preference for visible paired mode. False allows an isolated/phantom desktop if the host supports it.',
      },
      timeout_ms: {
        type: 'number',
        description: `Optional timeout in milliseconds. Capped at ${MAX_TIMEOUT_MS}.`,
      },
    },
    required: ['goal'],
  },
};

export class ComputerUseHostTool implements Tool {
  readonly definition = DEFINITION;

  async execute(args: Record<string, unknown>, ctx: ToolExecutionContext): Promise<ToolResult> {
    const goal = requireString(args, 'goal');
    const targetApp = optionalString(args, 'target_app');
    const url = optionalString(args, 'url');
    const visible = optionalBoolean(args, 'visible');
    const requestedTimeout = optionalNumber(args, 'timeout_ms');
    const timeoutMs = Math.min(Math.max(requestedTimeout ?? 90_000, 5_000), MAX_TIMEOUT_MS);

    if (!isAutomaxHosted()) {
      return {
        summary: 'host unavailable',
        content:
          'Computer use needs the Automax host to provide desktop/browser control. ' +
          'This standalone AutoCode process cannot run computer use by itself.',
        isError: true,
      };
    }

    const result = await requestHostResult(
      'computer_use',
      {
        goal,
        targetApp,
        url,
        visible,
        projectRoot: ctx.session.projectRoot,
        sessionId: ctx.session.sessionId,
      },
      timeoutMs,
    );

    if (!result) {
      return {
        summary: 'no host response',
        content: `The Automax host did not return a computer-use result within ${timeoutMs}ms.`,
        isError: true,
      };
    }
    if (result.ok === false) {
      return {
        summary: 'computer use failed',
        content: String(result.error ?? 'computer use failed'),
        isError: true,
      };
    }

    const content =
      typeof result.content === 'string' ? result.content :
      typeof result.text === 'string' ? result.text :
      typeof result.output === 'string' ? result.output :
      JSON.stringify(result, null, 2);

    const image = imageFromResult(result);
    return {
      summary: typeof result.summary === 'string' ? result.summary : 'computer-use result',
      content,
      metadata: image ? { image } : undefined,
    };
  }
}

function imageFromResult(result: Record<string, unknown>): ImageBlock | null {
  const data = result.image ?? result.data;
  if (typeof data !== 'string' || data.length === 0) return null;
  return {
    type: 'image',
    mediaType: typeof result.mediaType === 'string' ? result.mediaType : 'image/png',
    data,
  };
}
