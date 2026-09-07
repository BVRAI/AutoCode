// tool_search — deferred tool loading (Phase 4.6). Past a few dozen tools a
// model's accuracy at picking the right one drops and every request pays for
// the schemas, so the registry keeps its core tools eager and hands the rest
// (MCP tools first) to this one: the model searches by keyword, gets the
// matching definitions back, and those tools become callable from then on.

import type { ToolRegistry } from '../agent/ToolRegistry.js';
import {
  optionalNumber,
  requireString,
  type Tool,
  type ToolDefinition,
  type ToolExecutionContext,
  type ToolResult,
} from './types.js';

const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 10;

export class ToolSearchTool implements Tool {
  readonly definition: ToolDefinition;

  constructor(private readonly registry: ToolRegistry) {
    this.definition = {
      name: 'tool_search',
      description:
        'Find and load tools that are not in your current tool list. This session has more tools than fit ' +
        'in every request (MCP servers, integrations); describe what you need in a few keywords ("jira issue", ' +
        '"browser screenshot", "postgres query") and the matching tools are returned with their full schemas ' +
        'and become callable immediately. Call it before assuming a capability is missing.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Keywords describing the capability (tool names match too).' },
          limit: { type: 'number', description: `Max tools to load. Default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}.` },
        },
        required: ['query'],
      },
    };
  }

  async execute(args: Record<string, unknown>, _ctx: ToolExecutionContext): Promise<ToolResult> {
    const query = requireString(args, 'query');
    const limit = Math.max(1, Math.min(MAX_LIMIT, Math.floor(optionalNumber(args, 'limit') ?? DEFAULT_LIMIT)));
    const hits = this.registry.searchDeferred(query, limit);
    if (hits.length === 0) {
      const names = this.registry.deferredNames();
      return {
        summary: `no tools match "${query}"`,
        content:
          `No deferred tool matches "${query}". ${names.length} tool${names.length === 1 ? ' is' : 's are'} available on demand: ` +
          `${names.slice(0, 40).join(', ')}${names.length > 40 ? ', …' : ''}. Try different keywords or a tool name.`,
      };
    }
    for (const h of hits) this.registry.loadDeferred(h.name);
    const body = hits
      .map((h) => `### ${h.name}\n${h.description}\n\nInput schema:\n${JSON.stringify(h.inputSchema)}`)
      .join('\n\n');
    return {
      summary: `loaded ${hits.length} tool${hits.length === 1 ? '' : 's'}: ${hits.map((h) => h.name).join(', ')}`,
      content: `${hits.length} tool${hits.length === 1 ? '' : 's'} loaded and callable from now on:\n\n${body}`,
      metadata: { loaded: hits.map((h) => h.name) },
    };
  }
}
