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
import { UseSkillTool } from '../tools/useSkill.js';
import { FindSymbolTool } from '../tools/findSymbol.js';
import { FileDepsTool } from '../tools/fileDeps.js';
import { ComputerUseTaskTool } from '../tools/computerUseTask.js';
import { ComputerUseHostTool } from '../tools/computerUseHost.js';
import { benchMode, computerUseEnabled, guiToolsEnabled, webToolsEnabled } from './toolAvailability.js';

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
    if (webToolsEnabled() && !benchMode()) {
      // Network-fetching tools are gated by the user-facing config flag and
      // by bench mode, where headless runs cannot act on web data.
      this.register(new WebFetchTool());
      this.register(new WebSearchTool());
    }
    if (guiToolsEnabled()) {
      // Browser/screenshot stay available for interactive users, but not
      // benchmark/headless runs.
      this.register(new OpenInBrowserTool());
      this.register(new CaptureScreenshotTool());
    }
    this.register(new AskUserTool());
    this.register(new TaskTool());
    this.register(new UseSkillTool());
    this.register(new FindSymbolTool());
    this.register(new FileDepsTool());
    this.syncOptionalTools();
  }

  // Factory for the `sights` mode registry (Automax V6's locked-down static
  // website builder). File ops inside the project root only.
  static forSights(): ToolRegistry {
    const r = new ToolRegistry();
    r.tools.clear();
    r.register(new ListDirectoryTool());
    r.register(new ReadFileTool());
    r.register(new EditFileTool());
    r.register(new WriteFileTool());
    r.register(new CreateDirectoryTool());
    r.register(new DeletePathTool());
    r.register(new GlobTool());
    r.register(new GrepTool());
    r.register(new TodoWriteTool());
    return r;
  }

  // Factory for constrained subagent registries.
  static forSubagent(type: SubagentType): ToolRegistry {
    const r = new ToolRegistry();
    r.tools.clear();
    switch (type) {
      case 'Explore':
        r.register(new ListDirectoryTool());
        r.register(new ReadFileTool());
        r.register(new GlobTool());
        r.register(new GrepTool());
        r.register(new FindSymbolTool());
        r.register(new FileDepsTool());
        if (webToolsEnabled() && !benchMode()) {
          r.register(new WebFetchTool());
          r.register(new WebSearchTool());
        }
        break;
      case 'ComputerUse':
        r.register(new ListDirectoryTool());
        r.register(new ReadFileTool());
        r.register(new GlobTool());
        r.register(new GrepTool());
        r.register(new FindSymbolTool());
        r.register(new FileDepsTool());
        r.register(new ComputerUseHostTool());
        break;
    }
    return r;
  }

  register(tool: Tool): void {
    this.tools.set(tool.definition.name, tool);
  }

  unregister(name: string): void {
    this.tools.delete(name);
  }

  syncOptionalTools(): void {
    if (computerUseEnabled() && !benchMode()) {
      if (!this.tools.has('computer_use_task')) this.register(new ComputerUseTaskTool());
    } else {
      this.unregister('computer_use_task');
    }
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
