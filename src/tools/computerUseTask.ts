import {
  optionalBoolean,
  optionalString,
  requireString,
  type Tool,
  type ToolDefinition,
  type ToolExecutionContext,
  type ToolResult,
} from './types.js';

const DEFINITION: ToolDefinition = {
  name: 'computer_use_task',
  description:
    'Delegate a bounded GUI/computer-use verification task to a separate computer-use runner. ' +
    'Use this after implementing or changing UI behavior when command-line checks are not enough. ' +
    'The main coding agent stays in control; the computer-use runner inspects or operates the app and ' +
    'returns concise findings. Only available when the user has enabled computer use.',
  inputSchema: {
    type: 'object',
    properties: {
      goal: {
        type: 'string',
        description:
          'Specific GUI task or verification goal, including what to inspect and what success/failure means.',
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
          'Optional preference for visible paired mode. False allows the host to use an isolated/phantom desktop if available.',
      },
      notes: {
        type: 'string',
        description: 'Optional extra context for the computer-use runner.',
      },
    },
    required: ['goal'],
  },
};

export class ComputerUseTaskTool implements Tool {
  readonly definition = DEFINITION;

  async execute(args: Record<string, unknown>, ctx: ToolExecutionContext): Promise<ToolResult> {
    const goal = requireString(args, 'goal');
    const targetApp = optionalString(args, 'target_app');
    const url = optionalString(args, 'url');
    const visible = optionalBoolean(args, 'visible');
    const notes = optionalString(args, 'notes');

    const depth = ctx.depth ?? 0;
    if (depth > 0) {
      return {
        summary: 'recursion not allowed',
        content: 'computer_use_task can only be called by the main agent, not from inside a subagent.',
        isError: true,
      };
    }
    if (!ctx.subagentFactory) {
      return {
        summary: 'computer-use runner unavailable',
        content: 'No subagent factory is attached to this tool execution context.',
        isError: true,
      };
    }

    const prompt = [
      `Goal: ${goal}`,
      targetApp ? `Target app/window hint: ${targetApp}` : null,
      url ? `URL: ${url}` : null,
      visible === undefined ? null : `Visible paired mode preferred: ${visible ? 'yes' : 'no'}`,
      notes ? `Additional context: ${notes}` : null,
      '',
      'Inspect or operate the GUI only as needed to answer the goal.',
      'Return concise findings for the coding agent: what you checked, what passed, what failed, and any exact visible error text.',
      'Do not edit project files. Do not ask the user questions.',
    ].filter((line): line is string => line !== null).join('\n');

    const t0 = Date.now();
    const result = await ctx.subagentFactory({
      type: 'ComputerUse',
      prompt,
      description: targetApp ? `computer use: ${targetApp}` : 'computer use',
      parentDepth: depth,
      parent: ctx.session,
    });
    const dt = Date.now() - t0;

    return {
      summary: `computer use (${result.iterations} iter, ${dt}ms${result.error ? ', ' + result.error : ''})`,
      content: result.text,
      isError: Boolean(result.error),
      metadata: {
        subagentType: 'ComputerUse',
        iterations: result.iterations,
        durationMs: dt,
        usage: result.usage,
        error: result.error,
      },
    };
  }
}
