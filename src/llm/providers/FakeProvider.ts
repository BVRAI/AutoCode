// FakeProvider — a scripted model for end-to-end tests of the console.
//
// Armed by AUTOCODE_FAKE_LLM=<script.json>: the router then hands every
// provider name this class, so a scenario runs through the real AgentLoop,
// tools, prompter and Ink UI with only the model canned. The script is an
// ordered list of turns; each turn is shorthand that expands into the same
// StreamEvent sequence a live provider produces (thinking deltas, tool-use
// blocks, text deltas, message_stop with usage). Tools execute for real
// against whatever project the harness was started in.
//
// Script shape:
//   {
//     "chunk": 8,               // optional: characters per text delta (default 8)
//     "delayMs": 5,             // optional: pause between deltas (default 5)
//     "loop": false,            // optional: restart from the top when exhausted
//     "turns": [
//       {
//         "when": "verbose",    // optional: only matches when the newest message contains this
//         "thinking": "…",      // optional
//         "tools": [{ "name": "read_file", "input": { "path": "src/cli.ts" } }],
//         "text": "…",          // optional
//         "usage": { "inputTokens": 1200, "outputTokens": 80 },   // optional
//         "delayMs": 0          // optional per-turn override
//       }
//     ]
//   }
// A turn with tools ends with stopReason 'tool_use'; the AgentLoop then runs
// them and calls back for the next turn. When the script is exhausted the
// provider answers with a short text so a session never hangs.

import { readFileSync } from 'node:fs';
import type {
  CompletionRequest,
  CompletionResponse,
  ContentBlock,
  LlmProvider,
  Message,
  StreamEvent,
  ToolUseBlock,
} from '../types.js';

export interface FakeTurn {
  when?: string;
  thinking?: string;
  tools?: Array<{ name: string; input: Record<string, unknown>; id?: string }>;
  text?: string;
  usage?: Partial<CompletionResponse['usage']>;
  delayMs?: number;
}

export interface FakeScript {
  chunk?: number;
  delayMs?: number;
  loop?: boolean;
  turns: FakeTurn[];
}

const EXHAUSTED_TEXT = 'Done — the fake script has no more turns.';

export function loadFakeScript(path: string): FakeScript {
  const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<FakeScript>;
  if (!Array.isArray(raw.turns)) throw new Error(`fake script ${path}: "turns" must be an array`);
  return { chunk: raw.chunk ?? 8, delayMs: raw.delayMs ?? 5, loop: raw.loop === true, turns: raw.turns };
}

/** Text of the newest message — user prompt or tool results — for `when` matching. */
export function lastMessageText(messages: Message[]): string {
  const last = messages[messages.length - 1];
  if (!last) return '';
  if (typeof last.content === 'string') return last.content;
  return last.content
    .map((b) => {
      if (b.type === 'text') return b.text;
      if (b.type === 'tool_result') return b.content;
      return '';
    })
    .join('\n');
}

export class FakeProvider implements LlmProvider {
  readonly name = 'fake';
  private cursor = 0;
  private callCount = 0;

  constructor(private readonly script: FakeScript) {}

  static fromEnv(): FakeProvider | null {
    const path = process.env.AUTOCODE_FAKE_LLM?.trim();
    if (!path) return null;
    return new FakeProvider(loadFakeScript(path));
  }

  /** Pick the next turn: sequential, skipping turns whose `when` does not match. */
  private nextTurn(req: CompletionRequest): FakeTurn | null {
    const turns = this.script.turns;
    if (turns.length === 0) return null;
    if (this.cursor >= turns.length) {
      if (!this.script.loop) return null;
      this.cursor = 0;
    }
    const haystack = lastMessageText(req.messages);
    for (let i = this.cursor; i < turns.length; i++) {
      const t = turns[i]!;
      if (t.when && !haystack.includes(t.when)) continue;
      this.cursor = i + 1;
      return t;
    }
    return null;
  }

  private buildResponse(req: CompletionRequest, turn: FakeTurn | null): CompletionResponse {
    this.callCount += 1;
    const content: ContentBlock[] = [];
    if (turn?.thinking) content.push({ type: 'thinking', text: turn.thinking });
    if (turn?.text) content.push({ type: 'text', text: turn.text });
    if (!turn) content.push({ type: 'text', text: EXHAUSTED_TEXT });
    const tools: ToolUseBlock[] = (turn?.tools ?? []).map((t, i) => ({
      type: 'tool_use',
      id: t.id ?? `fake-${this.callCount}-${i + 1}`,
      name: t.name,
      input: t.input ?? {},
    }));
    content.push(...tools);
    const usage = {
      inputTokens: turn?.usage?.inputTokens ?? 1000 + this.callCount * 100,
      outputTokens: turn?.usage?.outputTokens ?? 50 + (turn?.text?.length ?? 0) / 4,
      cacheReadTokens: turn?.usage?.cacheReadTokens ?? 0,
      cacheWriteTokens: turn?.usage?.cacheWriteTokens ?? 0,
    };
    return {
      model: req.model,
      stopReason: tools.length > 0 ? 'tool_use' : 'end_turn',
      content,
      usage,
    };
  }

  async complete(req: CompletionRequest): Promise<CompletionResponse> {
    return this.buildResponse(req, this.nextTurn(req));
  }

  async *completeStream(req: CompletionRequest): AsyncIterable<StreamEvent> {
    const turn = this.nextTurn(req);
    const response = this.buildResponse(req, turn);
    const delay = turn?.delayMs ?? this.script.delayMs ?? 5;
    const chunk = Math.max(1, this.script.chunk ?? 8);
    const pause = async (): Promise<void> => {
      if (delay > 0) await new Promise((r) => setTimeout(r, delay));
      if (req.signal?.aborted) throw new Error('aborted');
    };
    for (const block of response.content) {
      if (block.type === 'thinking') {
        for (const piece of split(block.text, chunk)) {
          yield { type: 'thinking_delta', text: piece };
          await pause();
        }
      } else if (block.type === 'text') {
        for (const piece of split(block.text, chunk)) {
          yield { type: 'text_delta', text: piece };
          await pause();
        }
      } else if (block.type === 'tool_use') {
        yield { type: 'tool_use_start', id: block.id, name: block.name };
        yield { type: 'tool_use_delta', argsJsonChunk: JSON.stringify(block.input) };
        yield { type: 'tool_use_stop' };
        await pause();
      }
    }
    yield { type: 'message_stop', response };
  }
}

function split(text: string, size: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}
