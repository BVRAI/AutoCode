import type {
  Tool,
  ToolDefinition,
  ToolExecutionContext,
  ToolResult,
} from '../tools/types.js';
import type { McpClientManager, DiscoveredTool } from './McpClientManager.js';

// Wraps a single MCP server tool as one of our Tools. The LLM sees it under
// the name `mcp__<server>__<tool>`, matching Claude Code's convention so
// users can copy/paste MCP server configs across tools.
export class McpTool implements Tool {
  readonly definition: ToolDefinition;

  constructor(
    private readonly manager: McpClientManager,
    private readonly discovered: DiscoveredTool,
  ) {
    this.definition = {
      name: `mcp__${discovered.serverName}__${discovered.toolName}`,
      description:
        `[MCP / ${discovered.serverName}] ${discovered.description || '(no description provided)'}`,
      inputSchema: (discovered.inputSchema as ToolDefinition['inputSchema']) ?? {
        type: 'object',
        properties: {},
      },
    };
  }

  async execute(args: Record<string, unknown>, _ctx: ToolExecutionContext): Promise<ToolResult> {
    const result = await this.manager.callTool(
      this.discovered.serverName,
      this.discovered.toolName,
      args,
    );
    return {
      summary: result.isError
        ? `mcp ${this.discovered.serverName}/${this.discovered.toolName} error`
        : `mcp ${this.discovered.serverName}/${this.discovered.toolName} ok`,
      content: result.content,
      isError: result.isError,
    };
  }
}
