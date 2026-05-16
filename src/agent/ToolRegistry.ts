import type { Tool, ToolExecutionContext, ToolResult } from '../tools/types.js';
import type { ToolSchema } from '../llm/types.js';

import { ListDirectoryTool } from '../tools/listDirectory.js';
import { ReadFileTool } from '../tools/readFile.js';
import { EditFileTool } from '../tools/editFile.js';
import { WriteFileTool } from '../tools/writeFile.js';
import { RunShellTool } from '../tools/runShell.js';
import { GlobTool } from '../tools/glob.js';
import { GrepTool } from '../tools/grep.js';
import { TodoWriteTool } from '../tools/todoWrite.js';
import { WebFetchTool } from '../tools/webFetch.js';
import { WebSearchTool } from '../tools/webSearch.js';

export class ToolRegistry {
  private readonly tools = new Map<string, Tool>();

  constructor() {
    this.register(new ListDirectoryTool());
    this.register(new ReadFileTool());
    this.register(new EditFileTool());
    this.register(new WriteFileTool());
    this.register(new RunShellTool());
    this.register(new GlobTool());
    this.register(new GrepTool());
    this.register(new TodoWriteTool());
    this.register(new WebFetchTool());
    this.register(new WebSearchTool());
  }

  register(tool: Tool): void {
    this.tools.set(tool.definition.name, tool);
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  schemas(): ToolSchema[] {
    return [...this.tools.values()].map((t) => ({
      name: t.definition.name,
      description: t.definition.description,
      inputSchema: t.definition.inputSchema,
    }));
  }

  async execute(
    name: string,
    args: Record<string, unknown>,
    ctx: ToolExecutionContext,
  ): Promise<ToolResult> {
    const tool = this.tools.get(name);
    if (!tool) {
      return { summary: 'unknown tool', content: `no such tool: ${name}`, isError: true };
    }
    try {
      return await tool.execute(args, ctx);
    } catch (e) {
      return {
        summary: `tool error`,
        content: e instanceof Error ? `${e.name}: ${e.message}` : String(e),
        isError: true,
      };
    }
  }
}
