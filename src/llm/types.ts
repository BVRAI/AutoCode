// Provider-neutral message + tool types. Each provider translates these to its native shape.

export type MessageRole = 'system' | 'user' | 'assistant';

export interface TextBlock {
  type: 'text';
  text: string;
}

export interface ToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResultBlock {
  type: 'tool_result';
  toolUseId: string;
  content: string;
  isError?: boolean;
}

export interface ImageBlock {
  type: 'image';
  mediaType: string; // e.g. 'image/png'
  data: string; // base64-encoded image bytes
}

export type ContentBlock = TextBlock | ToolUseBlock | ToolResultBlock | ImageBlock;

export interface Message {
  role: MessageRole;
  content: string | ContentBlock[];
}

export interface ToolSchema {
  name: string;
  description: string;
  inputSchema: unknown;
}

export interface CompletionRequest {
  model: string;
  /** Stable system prompt — the cacheable prefix. */
  system: string;
  /** Optional volatile system content appended AFTER `system`. Providers that
   *  support cache breakpoints (Anthropic) place the breakpoint between the two
   *  so this suffix can change every turn without busting the cached prefix;
   *  others concatenate it onto `system`. */
  systemVolatile?: string;
  messages: Message[];
  tools: ToolSchema[];
  maxTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
}

export interface CompletionResponse {
  model: string;
  stopReason: 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence' | 'error';
  content: ContentBlock[];
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
  };
}

export interface LlmProvider {
  readonly name: string;
  complete(req: CompletionRequest): Promise<CompletionResponse>;
  completeStream?(req: CompletionRequest): AsyncIterable<StreamEvent>;
}

export type StreamEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'tool_use_start'; id: string; name: string }
  | { type: 'tool_use_delta'; argsJsonChunk: string }
  | { type: 'tool_use_stop' }
  | { type: 'message_stop'; response: CompletionResponse };
