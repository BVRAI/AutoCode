// The app-server protocol (Phase 5.1): JSON-RPC 2.0, one JSON object per
// line, over stdio (`autocode --server`). Modeled on `codex exec --json`
// item types and `claude -p --output-format stream-json`: a host drives a
// session with a few methods and reads a stream of notifications.
//
// Methods (client → server, get a response):
//   initialize            → { protocolVersion, version, capabilities }
//   session.new           { projectRoot?, provider?, model?, mode?, effort?, locale? } → { sessionId, model, mode }
//   session.resume        { sessionId } → same as session.new
//   turn.submit           { text, images?: [{ mediaType, data }] } → { turnId }   (the turn streams as notifications)
//   turn.cancel           {} → { cancelled }
//   respond               { requestId, ...answer } → {}   (answers request.* notifications)
//   session.setMode       { mode } → { mode }
//   session.command       { name, args? } → { output }   (compact, clear, model, effort, status, undo, refresh, memory, hooks, mcp)
//   session.info          {} → { sessionId, model, mode, usage, contextTokens, filesChanged }
//   shutdown              {} → {}
//
// Notifications (server → client, no id):
//   session.ready, turn.started, turn.completed, turn.failed, turn.cancelled
//   item.started / item.updated / item.completed — item.type ∈ agent_message | reasoning |
//     tool_call | file_change | todo | review | verification | note
//   request.approval / request.confirm / request.choose / request.text — answer with `respond`
//   status (activity label), usage (per turn), log (info|warn|error text)

export const PROTOCOL_VERSION = 1;

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number | string;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number | string | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcResponse;

export const ERR_PARSE = -32700;
export const ERR_INVALID_REQUEST = -32600;
export const ERR_METHOD_NOT_FOUND = -32601;
export const ERR_INVALID_PARAMS = -32602;
export const ERR_INTERNAL = -32603;
export const ERR_NO_SESSION = -32001;
export const ERR_BUSY = -32002;

export type ItemType = 'agent_message' | 'reasoning' | 'tool_call' | 'file_change' | 'todo' | 'review' | 'verification' | 'note';

export interface ItemBase {
  id: string;
  type: ItemType;
  turnId: string;
}

export interface AgentMessageItem extends ItemBase {
  type: 'agent_message';
  text: string;
}

export interface ReasoningItem extends ItemBase {
  type: 'reasoning';
  text: string;
  durationMs?: number;
}

export interface ToolCallItem extends ItemBase {
  type: 'tool_call';
  name: string;
  args: Record<string, unknown>;
  status: 'running' | 'ok' | 'error';
  summary?: string;
  content?: string;
  durationMs?: number;
  metadata?: Record<string, unknown>;
}

export interface FileChangeItem extends ItemBase {
  type: 'file_change';
  path: string;
  diff: string;
  added: number;
  removed: number;
}

export interface NoteItem extends ItemBase {
  type: 'note';
  level: 'info' | 'warn' | 'error';
  text: string;
}

export type Item = AgentMessageItem | ReasoningItem | ToolCallItem | FileChangeItem | NoteItem | (ItemBase & Record<string, unknown>);

export function parseLine(line: string): JsonRpcMessage | null {
  const t = line.trim();
  if (!t) return null;
  const parsed = JSON.parse(t) as Record<string, unknown>;
  if (!parsed || typeof parsed !== 'object') throw new Error('not an object');
  return parsed as unknown as JsonRpcMessage;
}

export function isRequest(m: JsonRpcMessage): m is JsonRpcRequest {
  return typeof (m as JsonRpcRequest).method === 'string' && (m as JsonRpcRequest).id !== undefined;
}

export function isNotification(m: JsonRpcMessage): m is JsonRpcNotification {
  return typeof (m as JsonRpcNotification).method === 'string' && (m as JsonRpcRequest).id === undefined;
}

export function isResponse(m: JsonRpcMessage): m is JsonRpcResponse {
  return (m as JsonRpcResponse).id !== undefined && typeof (m as JsonRpcRequest).method !== 'string';
}
