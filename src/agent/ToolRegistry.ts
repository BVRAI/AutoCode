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
import { SearchCommitsTool, ShowCommitTool } from '../tools/gitHistory.js';
import { SearchEntityTool } from '../tools/searchEntity.js';
import { TraverseGraphTool } from '../tools/traverseGraph.js';
import { RetrieveEntityTool } from '../tools/retrieveEntity.js';
import { ComputerUseTaskTool } from '../tools/computerUseTask.js';
import { ComputerUseHostTool } from '../tools/computerUseHost.js';
import { benchMode, computerUseEnabled, guiToolsEnabled, webToolsEnabled } from './toolAvailability.js';
import { ToolSearchTool } from '../tools/toolSearch.js';
import { SaveMemoryTool } from '../tools/saveMemory.js';

// Anthropic's guidance: accuracy degrades past 30–50 tools; keep the core
// eager and search the rest.
export const DEFER_THRESHOLD = 30;

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
    this.registerIndexTools();
    this.register(new SaveMemoryTool());
    this.registerGitHistoryTools();
    this.syncOptionalTools();
  }

  // Git-history tools ("where was this last changed"). Optional: they defer
  // behind tool_search once the registry is large, and are absent where
  // there is no repository to ask (AUTOCODE_NO_GIT_TOOLS=1 hides them).
  private registerGitHistoryTools(): void {
    if (process.env.AUTOCODE_NO_GIT_TOOLS === '1') return;
    this.registerOptional(new SearchCommitsTool());
    this.registerOptional(new ShowCommitTool());
  }

  // The tree-sitter code index tools (Phase 3). AUTOCODE_NO_INDEX=1 keeps
  // them out of the schema list entirely so a disabled index never tempts
  // the model into calls that can only fail.
  private registerIndexTools(): void {
    if (process.env.AUTOCODE_NO_INDEX === '1') return;
    this.register(new SearchEntityTool());
    this.register(new TraverseGraphTool());
    this.register(new RetrieveEntityTool());
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
        r.registerIndexTools();
        r.registerGitHistoryTools();
        if (webToolsEnabled() && !benchMode()) {
          r.register(new WebFetchTool());
          r.register(new WebSearchTool());
        }
        break;
      case 'Localize':
        // Read-only, index-first: the "which code does the user mean" funnel.
        r.register(new ListDirectoryTool());
        r.register(new ReadFileTool());
        r.register(new GlobTool());
        r.register(new GrepTool());
        r.register(new FindSymbolTool());
        r.register(new FileDepsTool());
        r.registerIndexTools();
        r.registerGitHistoryTools();
        break;
      case 'Review':
        // Read-only, graph-aware: the reviewer verifies claims in the code
        // and checks callers of what changed.
        r.register(new ListDirectoryTool());
        r.register(new ReadFileTool());
        r.register(new GlobTool());
        r.register(new GrepTool());
        r.register(new FindSymbolTool());
        r.register(new FileDepsTool());
        r.registerIndexTools();
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
    this.deferred.delete(name);
  }

  // ── Deferred tools (Phase 4.6) ────────────────────────────────────────
  // Past DEFER_THRESHOLD tools, MCP tools stop riding in every request: they
  // are searchable through `tool_search` and join the schema list once
  // loaded. Core tools are never deferred.

  private readonly deferred = new Set<string>();
  private toolSearch: ToolSearchTool | null = null;

  /** Register an MCP (or other optional) tool; deferred once the list is big. */
  registerOptional(tool: Tool): void {
    this.register(tool);
    this.deferred.add(tool.definition.name);
    this.applyDeferralPolicy();
  }

  private applyDeferralPolicy(): void {
    // Below the threshold every optional tool is eager; past it, all of them
    // wait behind tool_search (a stable rule, so the prompt prefix does not
    // depend on registration order).
    if (this.tools.size > DEFER_THRESHOLD && !this.toolSearch) {
      this.toolSearch = new ToolSearchTool(this);
      this.tools.set(this.toolSearch.definition.name, this.toolSearch);
    }
  }

  private readonly loaded = new Set<string>();

  private deferralActive(): boolean {
    return this.tools.size > DEFER_THRESHOLD;
  }

  /** True when the tool is deferred and not yet loaded into the schema list. */
  isDeferred(name: string): boolean {
    return this.deferralActive() && this.deferred.has(name) && !this.loaded.has(name);
  }

  deferredNames(): string[] {
    if (!this.deferralActive()) return [];
    return [...this.deferred].filter((n) => !this.loaded.has(n)).sort();
  }

  loadDeferred(name: string): void {
    if (this.deferred.has(name)) this.loaded.add(name);
  }

  /** Keyword search over deferred tools' names and descriptions. */
  searchDeferred(query: string, limit: number): Array<{ name: string; description: string; inputSchema: unknown; score: number }> {
    const terms = query
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length >= 2);
    const hits: Array<{ name: string; description: string; inputSchema: unknown; score: number }> = [];
    for (const name of this.deferredNames()) {
      const tool = this.tools.get(name);
      if (!tool) continue;
      const hay = `${name} ${tool.definition.description}`.toLowerCase();
      const nameLower = name.toLowerCase();
      let score = 0;
      for (const t of terms) {
        if (nameLower.includes(t)) score += 3;
        else if (hay.includes(t)) score += 1;
      }
      if (query.trim().toLowerCase() === nameLower) score += 10;
      if (score > 0) hits.push({ name, description: tool.definition.description, inputSchema: tool.definition.inputSchema, score });
    }
    return hits.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name)).slice(0, limit);
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
    return [...this.tools.values()]
      .filter((t) => !this.isDeferred(t.definition.name))
      .map((t) => ({
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
