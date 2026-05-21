import type { Tool, ToolExecutionContext, ToolResult, SubagentType } from '../tools/types.js';
import type { ToolSchema } from '../llm/types.js';

import { ListDirectoryTool } from '../tools/listDirectory.js';
import { ReadFileTool } from '../tools/readFile.js';
import { EditFileTool } from '../tools/editFile.js';
import { WriteFileTool } from '../tools/writeFile.js';
import { CreateDirectoryTool } from '../tools/createDirectory.js';
import { DeletePathTool } from '../tools/deletePath.js';
import { RunShellTool } from '../tools/runShell.js';
import { GlobTool } from '../tools/glob.js';
import { GrepTool } from '../tools/grep.js';
import { TodoWriteTool } from '../tools/todoWrite.js';
import { WebFetchTool } from '../tools/webFetch.js';
import { WebSearchTool } from '../tools/webSearch.js';
import { OpenInBrowserTool } from '../tools/openInBrowser.js';
import { CaptureScreenshotTool } from '../tools/captureScreenshot.js';
import { AskUserTool } from '../tools/askUser.js';
import { TaskTool } from '../tools/task.js';

export class ToolRegistry {
  private readonly tools = new Map<string, Tool>();

  constructor() {
    this.register(new ListDirectoryTool());
    this.register(new ReadFileTool());
    this.register(new EditFileTool());
    this.register(new WriteFileTool());
    this.register(new CreateDirectoryTool());
    this.register(new DeletePathTool());
    this.register(new RunShellTool());
    this.register(new GlobTool());
    this.register(new GrepTool());
    this.register(new TodoWriteTool());
    this.register(new WebFetchTool());
    this.register(new WebSearchTool());
    this.register(new OpenInBrowserTool());
    this.register(new CaptureScreenshotTool());
    this.register(new AskUserTool());
    this.register(new TaskTool());
  }

  // Factory for constrained subagent registries. Returns a registry that
  // includes ONLY the read-only research tools — no edit/write/shell, no
  // task tool (so subagents can't spawn further subagents).
  static forSubagent(type: SubagentType): ToolRegistry {
    const r = new ToolRegistry();
    // Clear the default full set and re-register a constrained subset.
    r.tools.clear();
    switch (type) {
      case 'Explore':
        r.register(new ListDirectoryTool());
        r.register(new ReadFileTool());
        r.register(new GlobTool());
        r.register(new GrepTool());
        r.register(new WebFetchTool());
        r.register(new WebSearchTool());
        break;
    }
    return r;
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
