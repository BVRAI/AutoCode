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

// A model's reasoning trace, captured so it can be echoed back on subsequent
// turns — reasoning models lose their train of thought mid-task when the
// harness drops this (MiniMax measured ~+3% SWE-bench from preserving it).
// Each provider both parses its native shape into this block and serializes
// it back out in the provider-correct way (or omits it, for providers that
// reject echoed reasoning).
export interface ThinkingBlock {
  type: 'thinking';
  /** Readable reasoning text ('' for redacted/encrypted-only blocks). */
  text: string;
  /** Anthropic thinking signature — must round-trip byte-for-byte. */
  signature?: string;
  /** Anthropic redacted_thinking payload — must round-trip byte-for-byte. */
  redactedData?: string;
  /** Provider-native structure kept for lossless echo (OpenRouter
   *  reasoning_details[], Gemini thoughtSignature). Replayed, never inspected. */
  opaque?: unknown;
}

export type ContentBlock = TextBlock | ToolUseBlock | ToolResultBlock | ImageBlock | ThinkingBlock;

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
  /** Request extended thinking / reasoning. Providers map it natively:
   *  Anthropic `thinking:{type:'enabled',budget_tokens}` (forces temp 1),
   *  OpenAI o-series & gpt-5 family `reasoning_effort`, Gemini
   *  `thinkingConfig` (currently never armed — thoughtSignature re-attach
   *  is deferred). Omitted → provider default (off). */
  thinking?: { budgetTokens: number };
  /** Ask the provider to clear stale tool results SERVER-SIDE once the
   *  prompt crosses `triggerInputTokens` (Anthropic context-management
   *  beta; applied after cache lookup, so unlike client-side masking it
   *  does NOT bust the prompt cache). Providers without support ignore it —
   *  the client-side mask/compact tiers remain as the fallback. */
  contextEditing?: { triggerInputTokens: number };
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
  // Reasoning trace streaming in. Consumers use if/else chains on evt.type,
  // so existing UIs ignore this safely (the spinner already reads "thinking").
  | { type: 'thinking_delta'; text: string }
  | { type: 'tool_use_start'; id: string; name: string }
  | { type: 'tool_use_delta'; argsJsonChunk: string }
  | { type: 'tool_use_stop' }
  | { type: 'message_stop'; response: CompletionResponse };
