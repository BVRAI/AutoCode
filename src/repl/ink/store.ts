// Transcript store — the source of truth for what the Ink Bridge UI renders.
//
// Two producers push into it:
//   1. The agent's event emitter (started, tool_call, tool_result,
//      file_edit_proposed, completed, failed) via createBridgeEventEmitter.
//   2. The ConsoleRenderer sink (assistant text, thinking, notices, diffs,
//      the end-of-turn line) via createRendererSink.
//
// The model is Claude Code's transcript: a user turn, tool rows with a
// collapsed result row, a collapsed thinking stub, the streamed answer and an
// end-of-turn duration line are COMMITTED (write-once); the status line, the
// live thinking/answer text and the running tool row are TRANSIENT. React
// subscribes via useBridgeState; all updates are immutable replacements.

import type { ApproveDetail, ApproveVerdict } from '../Prompter.js';
import {
  describeCall,
  describeResult,
  diffRows,
  summarizeThinking,
  type DiffRow,
  type RawResult,
  type TodoRow,
  type ToolGroup,
} from './grammar.js';

export type MsgKind =
  | 'user'        // user prompt (rendered as a tinted band)
  | 'assistant'   // the agent's answer, markdown
  | 'info'        // dim system line
  | 'warn'
  | 'error'
  | 'rule'        // legacy separator; not rendered
  | 'tool'        // tool call row + result row (see ToolEntry)
  | 'thinking'    // collapsed thinking stub ("Thought for 5s")
  | 'diff'        // standalone diff (rare — edits attach theirs to the tool row)
  | 'compact'     // compaction notice
  | 'turn_end';   // "✻ Sautéed for 23s · done 6:05 PM"

export interface ToolDiff {
  kind: 'add' | 'del' | 'context' | 'hunk';
  text: string;
}

export interface ToolEntry {
  id: string;
  name: string;            // canonical tool name, e.g. 'read_file'
  label: string;           // display label, e.g. 'Read'
  arg: string;             // primary argument, e.g. the path
  group: ToolGroup;        // consecutive same-group rows may collapse
  target?: string;         // legacy alias of arg (cockpit renderer)
  detail?: string;         // legacy short meta (cockpit renderer)
  status: 'running' | 'ok' | 'err';
  startedAt: number;
  endedAt?: number;
  durationMs?: number;
  summary?: string;        // the ⎿ line
  lines?: number;          // logical line count of the result
  bodyLines?: string[];    // lines under the summary (Bash output, errors)
  hiddenLines?: number;    // "… +N lines (ctrl+o to expand)"
  todos?: TodoRow[];       // todo_write: the checklist
  diffRows?: DiffRow[];    // edits: numbered diff
  diffHidden?: number;
  stats?: { added: number; removed: number };
  body?: string;           // legacy free-form body (cockpit renderer)
  diff?: ToolDiff[];       // legacy inline diff (cockpit renderer)
}

export interface TurnEndInfo {
  durationMs: number;
  endedAt: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
  todos?: { done: number; total: number; interrupted: number };
}

export interface TranscriptItem {
  id: string;
  kind: MsgKind;
  text?: string;            // user/assistant/info/warn/error/compact text
  tool?: ToolEntry;         // kind === 'tool'
  diff?: { label: string; before: string; after: string };
  durationMs?: number;      // thinking stub / turn_end
  turnEnd?: TurnEndInfo;    // kind === 'turn_end'
  thinkingLines?: string[]; // thinking stub: the ≤10-line summary
  turn: number;
  ts: number;
}

export interface RailEditSummary {
  file: string;
  added: number;
  deleted: number;
  isNew: boolean;
}

export interface McpStatusEntry {
  name: string;
  connected: boolean;
  toolCount: number;
  error?: string;
}

// An interactive prompt surfaced as a Bridge overlay (the BridgePrompter
// pushes one of these; PromptOverlay renders it; the embedded resolve
// callback completes the prompter's pending promise). One at a time —
// BridgePrompter serializes requests through an internal queue.
export type PromptRequest =
  | { type: 'confirm'; message: string; resolve: (yes: boolean) => void }
  | { type: 'ask'; message: string; resolve: (answer: string) => void }
  | {
      type: 'choose';
      question: string;
      options: string[];
      multiSelect: boolean;
      resolve: (picked: number[]) => void;
    }
  | {
      type: 'approve';
      label: string;
      detail?: ApproveDetail;
      resolve: (verdict: ApproveVerdict) => void;
    };

export interface Activity {
  verb: string;            // "Thinking", "Reading", "Running"…
  since: number;
}

export interface BridgeState {
  turn: number;
  busy: boolean;
  mode: 'planning' | 'default' | 'autocode' | 'admin' | 'sights';
  // Legacy spinner label — kept for the cockpit renderer; the inline renderer
  // reads `activity` instead.
  thinking: string | null;
  thinkingStartedAt: number | null;
  activity: Activity | null;
  // Transient thinking text while the model reasons (collapsed to a stub on end).
  thinkingLive: { text: string; since: number } | null;
  // Transient answer text while it streams (committed as an item on end).
  streaming: string | null;
  // Rough count of output characters received this turn — the status line's
  // token estimate until real usage arrives.
  liveOutputChars: number;
  turnStartedAt: number | null;
  // Ctrl+O: results commit expanded instead of collapsed.
  verbose: boolean;
  // The resolved thinking policy for the status line ("high effort"), or null.
  effort: string | null;
  editsThisTurn: RailEditSummary[];
  mcpStatus: McpStatusEntry[];
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    costUsd: number;
    // Live context occupancy (≈ last request's input tokens) and the selected
    // model's real window, for the context meter — distinct from the
    // cumulative in/out totals above.
    currentContextTokens: number;
    contextWindow: number;
  };
  queueDepth: number;
  items: TranscriptItem[];
  overlay:
    | { kind: 'model-provider' }
    | { kind: 'model-models'; provider: string }
    | { kind: 'byok' }
    | { kind: 'prompt'; request: PromptRequest }
    | null;
  model: { provider: string; name: string };
  project: { root: string; branch: string | null; dirty: number };
  // Todo tray — mirrors the todo_write list so a multi-step task always shows
  // its progress above the composer. Ctrl+T expands/collapses.
  plan: { items: PlanItem[]; collapsed: boolean };
}

export interface PlanItem {
  text: string;
  status: 'pending' | 'in_progress' | 'completed' | 'interrupted';
}

type Listener = (s: BridgeState) => void;

const INITIAL: BridgeState = {
  turn: 0,
  busy: false,
  mode: 'default',
  thinking: null,
  thinkingStartedAt: null,
  activity: null,
  thinkingLive: null,
  streaming: null,
  liveOutputChars: 0,
  turnStartedAt: null,
  verbose: false,
  effort: null,
  editsThisTurn: [],
  mcpStatus: [],
  usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0, currentContextTokens: 0, contextWindow: 0 },
  queueDepth: 0,
  items: [],
  overlay: null,
  model: { provider: '', name: '' },
  project: { root: '', branch: null, dirty: 0 },
  plan: { items: [], collapsed: true },
};

let _id = 0;
const nid = (): string => `i${++_id}`;

export class BridgeStore {
  private state: BridgeState = INITIAL;
  private readonly listeners = new Set<Listener>();
  // Tool args by id — needed when the result arrives to phrase the ⎿ line.
  private readonly toolArgs = new Map<string, Record<string, unknown>>();
  // The most recently finished edit/write, so a diff that follows attaches to it.
  private lastFinishedToolId: string | null = null;
  // What the next user band shows instead of the submitted text (placeholders
  // for long pastes and images, Claude Code style). Consumed by the next turn.
  private pendingUserDisplay: string | null = null;

  setUserDisplay(text: string | null): void {
    this.pendingUserDisplay = text;
  }

  takeUserDisplay(): string | null {
    const t = this.pendingUserDisplay;
    this.pendingUserDisplay = null;
    return t;
  }

  get(): BridgeState {
    return this.state;
  }

  subscribe(cb: Listener): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private emit(next: BridgeState): void {
    this.state = next;
    for (const l of this.listeners) l(next);
  }

  private append(
    item: Omit<TranscriptItem, 'id' | 'turn' | 'ts'> & { id?: string },
    extra: Partial<BridgeState> = {},
  ): void {
    const { id, ...rest } = item;
    this.emit({
      ...this.state,
      ...extra,
      items: [...this.state.items, { id: id ?? nid(), turn: this.state.turn, ts: Date.now(), ...rest }],
    });
  }

  // ── transcript ops ────────────────────────────────────────────────────

  appendText(kind: Exclude<MsgKind, 'tool' | 'diff' | 'turn_end' | 'thinking'>, text: string): void {
    this.append({ kind, text });
  }

  appendRule(): void {
    this.append({ kind: 'rule' });
  }

  appendDiff(label: string, before: string, after: string): void {
    this.append({ kind: 'diff', diff: { label, before, after } });
  }

  /** A tool call has started: the row commits when it finishes. */
  startTool(name: string, args: Record<string, unknown>): string {
    const id = nid();
    const d = describeCall(name, args);
    const tool: ToolEntry = {
      id,
      name,
      label: d.label,
      arg: d.arg,
      group: d.group,
      target: d.arg || undefined,
      status: 'running',
      startedAt: Date.now(),
    };
    this.toolArgs.set(id, args);
    // The row's item id IS the tool id, so finishTool/closeTool can find it.
    this.append({ id, kind: 'tool', tool });
    return id;
  }

  updateTool(id: string, patch: Partial<ToolEntry>): void {
    const items = this.state.items.map((it) => {
      if (it.id !== id || !it.tool) return it;
      return { ...it, tool: { ...it.tool, ...patch } };
    });
    this.emit({ ...this.state, items });
  }

  /** The result arrived: phrase the ⎿ line and commit the row. */
  finishTool(id: string, result: RawResult, durationMs?: number): void {
    const item = this.state.items.find((it) => it.id === id);
    if (!item?.tool) return;
    const args = this.toolArgs.get(id) ?? {};
    this.toolArgs.delete(id);
    const r = describeResult(item.tool.name, args, result, { verbose: this.state.verbose });
    const patch: Partial<ToolEntry> = {
      status: result.isError ? 'err' : 'ok',
      endedAt: Date.now(),
      durationMs,
      summary: r.summary,
      lines: r.lines,
      bodyLines: r.bodyLines,
      hiddenLines: r.hiddenLines,
      todos: r.todos,
      detail: r.summary || undefined,
      body: r.bodyLines ? r.bodyLines.join('\n') : undefined,
    };
    this.updateTool(id, patch);
    this.lastFinishedToolId = item.tool.name === 'edit_file' || item.tool.name === 'write_file' ? id : null;
  }

  /** Close a row the loop abandoned (a later event implies it ended). */
  closeTool(id: string, status: 'ok' | 'err'): void {
    const item = this.state.items.find((it) => it.id === id);
    if (!item?.tool || item.tool.status !== 'running') return;
    this.toolArgs.delete(id);
    this.updateTool(id, { status, endedAt: Date.now() });
  }

  /** A before/after pair for the edit that just finished: numbered diff + stats. */
  attachDiff(label: string, before: string, after: string): void {
    const id = this.lastFinishedToolId;
    this.lastFinishedToolId = null;
    const item = id ? this.state.items.find((it) => it.id === id) : undefined;
    if (!item?.tool) {
      this.appendDiff(label, before, after);
      return;
    }
    const { rows, stats, hidden } = diffRows(before, after, this.state.verbose ? 200 : 24);
    const path = item.tool.arg || label;
    const summary =
      item.tool.name === 'edit_file'
        ? `Updated ${path} with ${stats.added} addition${stats.added === 1 ? '' : 's'} and ${stats.removed} removal${stats.removed === 1 ? '' : 's'}`
        : item.tool.summary ?? `Wrote ${path}`;
    this.updateTool(item.id, { diffRows: rows, diffHidden: hidden, stats, summary, detail: summary });
  }

  // ── streaming / thinking / turn ───────────────────────────────────────

  streamChunk(text: string): void {
    this.emit({
      ...this.state,
      streaming: (this.state.streaming ?? '') + text,
      liveOutputChars: this.state.liveOutputChars + text.length,
    });
  }

  /** The answer finished streaming: commit it as an item. */
  commitAssistant(text: string): void {
    if (text.trim().length === 0) {
      if (this.state.streaming !== null) this.emit({ ...this.state, streaming: null });
      return;
    }
    this.append({ kind: 'assistant', text }, { streaming: null });
  }

  thinkingChunk(text: string): void {
    const cur = this.state.thinkingLive;
    this.emit({
      ...this.state,
      thinkingLive: { text: (cur?.text ?? '') + text, since: cur?.since ?? Date.now() },
      liveOutputChars: this.state.liveOutputChars + text.length,
    });
  }

  /** Thinking ended: commit the collapsed stub, clear the live text. */
  thinkingEnd(durationMs: number): void {
    const text = this.state.thinkingLive?.text ?? '';
    const lines = summarizeThinking(text);
    this.append({ kind: 'thinking', durationMs, thinkingLines: lines }, { thinkingLive: null });
  }

  turnEnd(info: TurnEndInfo): void {
    this.append(
      { kind: 'turn_end', durationMs: info.durationMs, turnEnd: info },
      { activity: null, thinkingLive: null, streaming: null, busy: false, turnStartedAt: null },
    );
  }

  setActivity(verb: string | null): void {
    const cur = this.state.activity;
    if (verb === null) {
      if (cur === null) return;
      this.emit({ ...this.state, activity: null });
      return;
    }
    if (cur && cur.verb === verb) return;
    this.emit({ ...this.state, activity: { verb, since: Date.now() } });
  }

  toggleVerbose(): void {
    this.emit({ ...this.state, verbose: !this.state.verbose });
  }

  setEffort(label: string | null): void {
    if (this.state.effort === label) return;
    this.emit({ ...this.state, effort: label });
  }

  // ── status ops ────────────────────────────────────────────────────────
  // All setters are equality-guarded: the polling refresh (usage / busy /
  // queue / mode every 1.5 s) would otherwise re-render the whole tree.

  setThinking(label: string | null): void {
    if (this.state.thinking === label) return;
    this.emit({ ...this.state, thinking: label, thinkingStartedAt: label ? Date.now() : null });
  }

  setBusy(busy: boolean): void {
    if (this.state.busy === busy) return;
    this.emit({ ...this.state, busy });
  }

  setMode(mode: BridgeState['mode']): void {
    if (this.state.mode === mode) return;
    this.emit({ ...this.state, mode });
  }

  setUsage(u: Partial<BridgeState['usage']>): void {
    const merged = { ...this.state.usage, ...u };
    const cur = this.state.usage;
    if (
      cur.inputTokens === merged.inputTokens &&
      cur.outputTokens === merged.outputTokens &&
      cur.cacheReadTokens === merged.cacheReadTokens &&
      cur.cacheWriteTokens === merged.cacheWriteTokens &&
      cur.costUsd === merged.costUsd &&
      cur.currentContextTokens === merged.currentContextTokens &&
      cur.contextWindow === merged.contextWindow
    ) {
      return;
    }
    this.emit({ ...this.state, usage: merged });
  }

  setQueueDepth(n: number): void {
    if (this.state.queueDepth === n) return;
    this.emit({ ...this.state, queueDepth: n });
  }

  setModel(provider: string, name: string): void {
    if (this.state.model.provider === provider && this.state.model.name === name) return;
    this.emit({ ...this.state, model: { provider, name } });
  }

  setProjectGit(branch: string | null, dirty: number): void {
    const cur = this.state.project;
    if (cur.branch === branch && cur.dirty === dirty) return;
    this.emit({ ...this.state, project: { ...cur, branch, dirty } });
  }

  setProjectRoot(root: string): void {
    if (this.state.project.root === root) return;
    this.emit({ ...this.state, project: { ...this.state.project, root } });
  }

  setPlan(items: PlanItem[]): void {
    const cur = this.state.plan.items;
    if (cur.length === items.length && cur.every((c, i) => c.text === items[i]!.text && c.status === items[i]!.status)) {
      return;
    }
    this.emit({ ...this.state, plan: { ...this.state.plan, items } });
  }

  togglePlanCollapsed(): void {
    this.emit({ ...this.state, plan: { ...this.state.plan, collapsed: !this.state.plan.collapsed } });
  }

  setOverlay(overlay: BridgeState['overlay']): void {
    if (this.state.overlay === overlay) return;
    this.emit({ ...this.state, overlay });
  }

  setMcpStatus(s: McpStatusEntry[]): void {
    if (s.length === this.state.mcpStatus.length) {
      let same = true;
      for (let i = 0; i < s.length; i++) {
        const a = s[i]!;
        const b = this.state.mcpStatus[i]!;
        if (a.name !== b.name || a.connected !== b.connected || a.toolCount !== b.toolCount || a.error !== b.error) {
          same = false;
          break;
        }
      }
      if (same) return;
    }
    this.emit({ ...this.state, mcpStatus: s });
  }

  // Start a new turn — bumps the counter, clears this-turn state.
  beginTurn(): void {
    this.emit({
      ...this.state,
      turn: this.state.turn + 1,
      editsThisTurn: [],
      turnStartedAt: Date.now(),
      liveOutputChars: 0,
      thinkingLive: null,
      streaming: null,
    });
  }

  recordEdit(e: RailEditSummary): void {
    const without = this.state.editsThisTurn.filter((x) => x.file !== e.file);
    this.emit({ ...this.state, editsThisTurn: [...without, e] });
  }

  // Reset everything — used by /clear.
  reset(): void {
    this.toolArgs.clear();
    this.lastFinishedToolId = null;
    this.emit({
      ...INITIAL,
      mode: this.state.mode,
      mcpStatus: this.state.mcpStatus,
      project: this.state.project,
      model: this.state.model,
      verbose: this.state.verbose,
      effort: this.state.effort,
    });
  }
}
