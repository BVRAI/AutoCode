import { parseLocalizeResult, renderLocalizeResult } from '../agent/Localize.js';
import {
  requireString,
  type SubagentType,
  type Tool,
  type ToolDefinition,
  type ToolExecutionContext,
  type ToolResult,
} from './types.js';

const SUBAGENT_TYPES: readonly SubagentType[] = ['Explore', 'Localize'] as const;

const DEFINITION: ToolDefinition = {
  name: 'task',
  description:
    'Delegate a focused research question to a subagent. The subagent runs its own ' +
    'sub-loop with a constrained tool set, gathers information, and returns a single ' +
    'self-contained text answer. Use this when answering a question would require many ' +
    'file reads, greps, or directory listings — the subagent keeps that work out of your ' +
    'main conversation so your context stays focused.\n\n' +
    'Do NOT use this tool for:\n' +
    '- Single-file lookups (just call read_file directly)\n' +
    '- Tasks that require modifying files (the subagent has read-only access)\n' +
    '- Interactive clarification with the user (the subagent cannot talk to the user)\n\n' +
    'For multi-part research (e.g. localizing a bug that could live in several ' +
    'subsystems), issue SEVERAL task calls in one message — they run in parallel, ' +
    'so N focused subagents finish in the time of the slowest one.\n\n' +
    'Subagent types:\n' +
    '- "Explore": open-ended read-only research; returns prose. Tools: list_directory, read_file, ' +
    'glob, grep, find_symbol, file_deps, search_entity, traverse_graph, retrieve_entity, web_fetch, web_search.\n' +
    '- "Localize": answers "which code does this request mean?" on a large codebase. Walks the code ' +
    'index (search_entity → traverse_graph → retrieve_entity) and returns a ranked list of ' +
    'path:line spans with symbols, reasoning and confidence, plus an ambiguity note when two ' +
    'readings of the request lead to different places. Use it before editing when the user names ' +
    'a feature loosely ("the export button", "where tasks get materialized"). Give it the user\'s ' +
    'words verbatim plus any hints you have.',
  inputSchema: {
    type: 'object',
    properties: {
      description: {
        type: 'string',
        description: 'Short label (5–10 words) describing the task, shown to the user during execution.',
      },
      subagent_type: {
        type: 'string',
        enum: [...SUBAGENT_TYPES],
        description: '"Explore" for open-ended research (prose answer); "Localize" to find the code a request refers to (ranked path:line spans).',
      },
      prompt: {
        type: 'string',
        description:
          'Full instructions for the subagent. Be specific about what you want returned and at ' +
          'what level of detail. The subagent sees no other context from your conversation.',
      },
    },
    required: ['description', 'subagent_type', 'prompt'],
  },
};

export class TaskTool implements Tool {
  readonly definition = DEFINITION;

  async execute(args: Record<string, unknown>, ctx: ToolExecutionContext): Promise<ToolResult> {
    const description = requireString(args, 'description');
    const subagentType = requireString(args, 'subagent_type');
    const prompt = requireString(args, 'prompt');

    if (!SUBAGENT_TYPES.includes(subagentType as SubagentType)) {
      return {
        summary: 'unknown subagent_type',
        content: `subagent_type must be one of: ${SUBAGENT_TYPES.join(', ')}. Got: ${subagentType}`,
        isError: true,
      };
    }

    const depth = ctx.depth ?? 0;
    if (depth > 0) {
      return {
        summary: 'recursion not allowed',
        content:
          'The task tool cannot be called from inside a subagent. ' +
          'Subagents must complete their own research without spawning further subagents.',
        isError: true,
      };
    }

    if (!ctx.subagentFactory) {
      return {
        summary: 'subagent factory not available',
        content: 'No subagent factory is attached to this tool execution context.',
        isError: true,
      };
    }

    const t0 = Date.now();
    const result = await ctx.subagentFactory({
      type: subagentType as SubagentType,
      prompt,
      description,
      parentDepth: depth,
      parent: ctx.session,
    });
    const dt = Date.now() - t0;

    // Localize returns a JSON contract; hand the parent the compact rendering
    // and keep the structured result in metadata for hosts and tests.
    let content = result.text;
    let localized: ReturnType<typeof parseLocalizeResult> = null;
    if (subagentType === 'Localize') {
      localized = parseLocalizeResult(result.text);
      if (localized) content = renderLocalizeResult(localized);
    }

    return {
      summary: `${description} (${result.iterations} iter, ${dt}ms${result.error ? ', ' + result.error : ''})`,
      content,
      isError: Boolean(result.error),
      metadata: {
        subagentType,
        iterations: result.iterations,
        toolUses: result.toolCalls ?? result.iterations,
        durationMs: dt,
        usage: result.usage,
        error: result.error,
        ...(localized ? { locations: localized.locations, ambiguity: localized.ambiguity } : {}),
      },
    };
  }
}
