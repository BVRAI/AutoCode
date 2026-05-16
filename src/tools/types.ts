import type { SessionContext } from '../session/SessionContext.js';

export interface ToolExecutionContext {
  session: SessionContext;
  // Returns true when the user agrees, false otherwise. Implementations may
  // throw if no interactive UI is attached.
  confirm?: (prompt: string) => Promise<boolean>;
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
