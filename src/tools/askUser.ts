import {
  optionalBoolean,
  requireString,
  type Tool,
  type ToolDefinition,
  type ToolExecutionContext,
  type ToolResult,
} from './types.js';

const DEFINITION: ToolDefinition = {
  name: 'ask_user',
  description:
    'Ask the user a multiple-choice question and get their selection. Use this to clarify an ' +
    'ambiguous requirement or let the user pick between approaches — instead of guessing. ' +
    'Set multi_select to let them choose several options.',
  inputSchema: {
    type: 'object',
    properties: {
      question: { type: 'string', description: 'The question to ask the user.' },
      options: {
        type: 'array',
        items: { type: 'string' },
        description: 'The choices to offer (2–8).',
      },
      multi_select: { type: 'boolean', description: 'Allow selecting multiple options. Default false.' },
    },
    required: ['question', 'options'],
  },
};

export class AskUserTool implements Tool {
  readonly definition = DEFINITION;

  async execute(args: Record<string, unknown>, ctx: ToolExecutionContext): Promise<ToolResult> {
    const question = requireString(args, 'question');
    const options = Array.isArray(args.options)
      ? args.options.filter((o): o is string => typeof o === 'string')
      : [];
    const multiSelect = optionalBoolean(args, 'multi_select') ?? false;

    if (options.length < 2) {
      return { summary: 'bad options', content: 'Provide at least 2 options.', isError: true };
    }
    if (!ctx.choose) {
      return {
        summary: 'no interactive user',
        content:
          'No interactive user is available to answer (e.g. headless run). ' +
          'Proceed with your best judgment and state the assumption you made.',
        isError: true,
      };
    }

    const picked = await ctx.choose(question, options, multiSelect);
    if (picked.length === 0) {
      return {
        summary: 'no selection',
        content: 'The user made no selection — proceed with your best judgment.',
        metadata: { selected: [] },
      };
    }
    const chosen = picked.map((i) => `${String.fromCharCode(65 + i)}) ${options[i]}`);
    return {
      summary: `user selected ${picked.length} option${picked.length === 1 ? '' : 's'}`,
      content: `User selected: ${chosen.join(', ')}`,
      metadata: { selected: picked, options },
    };
  }
}
