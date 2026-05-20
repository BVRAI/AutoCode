import type { SessionContext } from '../session/SessionContext.js';
import type { CheckpointStore } from '../session/CheckpointStore.js';

// Function passed in via ToolExecutionContext so the `task` tool can delegate
// to a subagent without importing AgentLoop/SubagentRunner directly. Kept as
// a structural type to avoid circular module deps.
export type SubagentType = 'Explore';
export type SubagentFactory = (input: {
  type: SubagentType;
  prompt: string;
  description: string;
  parentDepth: number;
  parent: SessionContext;
}) => Promise<{
  text: string;
  usage: { inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number };
  iterations: number;
  error?: string;
}>;

export interface ToolExecutionContext {
  session: SessionContext;
  // Returns true when the user agrees, false otherwise. Implementations may
  // throw if no interactive UI is attached.
  confirm?: (prompt: string) => Promise<boolean>;
  // Nesting depth — 0 in the main agent, 1+ inside subagents. The `task`
  // tool refuses to spawn when depth > 0 to prevent recursion.
  depth?: number;
  // Factory the `task` tool invokes. Set by AgentLoop on the main agent's
  // ToolExecutionContext; intentionally absent inside subagents so the
  // task tool isn't usable there (defense in depth alongside the registry
  // not registering `task` for Explore).
  subagentFactory?: SubagentFactory;
  // Snapshot store — file tools record before-state here so edits are
  // undoable and deletes are recoverable from the trash.
  checkpoint?: CheckpointStore;
}

export type JsonSchema = {
  type: string;
  properties?: Record<string, JsonSchema | { type: string; description?: string; default?: unknown; enum?: string[] }>;
  required?: string[];
  description?: string;
  items?: JsonSchema | { type: string };
  enum?: string[];
};

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: JsonSchema;
}

export interface ToolResult {
  summary: string;
  content: string;
  isError?: boolean;
  metadata?: Record<string, unknown>;
}

export interface Tool {
  readonly definition: ToolDefinition;
  execute(args: Record<string, unknown>, ctx: ToolExecutionContext): Promise<ToolResult>;
}

export function requireString(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  if (typeof v !== 'string' || v.length === 0) {
    throw new Error(`argument '${key}' must be a non-empty string`);
  }
  return v;
}

export function optionalString(args: Record<string, unknown>, key: string): string | undefined {
  const v = args[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string') {
    throw new Error(`argument '${key}' must be a string`);
  }
  return v;
}

export function optionalNumber(args: Record<string, unknown>, key: string): number | undefined {
  const v = args[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    throw new Error(`argument '${key}' must be a number`);
  }
  return v;
}

export function optionalBoolean(args: Record<string, unknown>, key: string): boolean | undefined {
  const v = args[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'boolean') {
    throw new Error(`argument '${key}' must be a boolean`);
  }
  return v;
}
