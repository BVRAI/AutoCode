// Transcript store — the source of truth for what the Ink Bridge UI renders.
//
// Two producers push into it:
//   1. The agent's event emitter (tool_call, file_edit_proposed, started,
//      completed, failed). We swap a `BridgeEventEmitter` into AgentLoop in
//      Ink mode that fans out to subscribers here.
//   2. The ConsoleRenderer (assistant text, info lines, diffs). In Ink mode
//      ConsoleRenderer's sink is set to a thin adapter that calls into this
//      store instead of writing to stdout.
//
// React subscribes via the `useStore` hook (see ./hooks.ts). All updates are
// immutable replacements so React diffing stays cheap.

export type MsgKind =
  | 'user'        // user prompt echoed into the transcript
  | 'assistant'   // agent narrative text
  | 'info'        // dim status / system line
  | 'warn'
  | 'error'
  | 'rule'        // horizontal rule between user prompt and reply
  | 'tool'        // tool call card (see ToolEntry below)
  | 'thinking'    // active spinner line (one at a time; replaced)
  | 'diff'        // standalone diff (rare — usually nested in a tool)
  | 'compact';    // compaction notice

export interface ToolDiff {
  kind: 'add' | 'del' | 'context' | 'hunk';
  text: string;
}

export interface ToolEntry {
  id: string;
  name: string;            // tool name, e.g. 'read_file', 'edit_file'
  target?: string;         // file/path argument when applicable
  detail?: string;         // short meta, e.g. "lines 1–48", "+5 −1"
  status: 'running' | 'ok' | 'err';
  startedAt: number;
  endedAt?: number;
  body?: string;           // free-form text body (e.g. read output excerpt)
  diff?: ToolDiff[];       // optional inline diff for edit/write
}

export interface TranscriptItem {
  id: string;
  kind: MsgKind;
  text?: string;           // for user/assistant/info/warn/error/thinking
  tool?: ToolEntry;        // for kind === 'tool'
  diff?: { label: string; before: string; after: string };
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

export interface BridgeState {
  turn: number;
  busy: boolean;
  mode: 'planning' | 'default' | 'autocode' | 'admin';
  thinking: string | null;       // current spinner label, or null
  thinkingStartedAt: number | null;
  editsThisTurn: RailEditSummary[];
  mcpStatus: McpStatusEntry[];
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    costUsd: number;
    // Live context occupancy (≈ last request's input tokens) and the selected
    // model's real window, for the rail's CONTEXT meter — distinct from the
    // cumulative in/out totals above.
    currentContextTokens: number;
    contextWindow: number;
  };
  queueDepth: number;
  items: TranscriptItem[];
  // Ephemeral overlay UI: discriminated union for whichever picker is
  // currently open, or null. The Bridge renders the right overlay
  // between the transcript region and the footer.
  //
  // The model picker is two-stage: 'model-provider' shows the list of
  // providers; selecting one transitions to 'model-models' which shows
  // only that provider's models. Esc from the model stage goes back to
  // the provider stage; Esc from the provider stage closes.
  overlay:
    | { kind: 'model-provider' }
    | { kind: 'model-models'; provider: string }
    | null;
  // Active model — surfaced for the rail's MODEL row and for the model
  // picker to show "current" highlight. Updated by the bench / user.
  model: { provider: string; name: string };
  // Project git summary for the rail's PROJECT row. `branch === null` means
  // the folder is not a git repo (rail shows "no git"). Refreshed on the
  // rail's poll timer, so it tracks branch switches mid-session.
  project: { branch: string | null; dirty: number };
}

type Listener = (s: BridgeState) => void;

const INITIAL: BridgeState = {
  turn: 0,
  busy: false,
  mode: 'default',
  thinking: null,
  thinkingStartedAt: null,
  editsThisTurn: [],
  mcpStatus: [],
  usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0, currentContextTokens: 0, contextWindow: 0 },
  queueDepth: 0,
  items: [],
  overlay: null,
  model: { provider: '', name: '' },
  project: { branch: null, dirty: 0 },
};

let _id = 0;
const nid = (): string => `i${++_id}`;

export class BridgeStore {
  private state: BridgeState = INITIAL;
  private readonly listeners = new Set<Listener>();

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

  // ── transcript ops ────────────────────────────────────────────────────

  appendText(kind: Exclude<MsgKind, 'tool' | 'diff'>, text: string): void {
    this.emit({
      ...this.state,
      items: [...this.state.items, { id: nid(), kind, text, turn: this.state.turn, ts: Date.now() }],
    });
  }

  appendRule(): void {
    this.emit({
      ...this.state,
      items: [...this.state.items, { id: nid(), kind: 'rule', turn: this.state.turn, ts: Date.now() }],
    });
  }

  appendDiff(label: string, before: string, after: string): void {
    this.emit({
      ...this.state,
      items: [
        ...this.state.items,
        { id: nid(), kind: 'diff', diff: { label, before, after }, turn: this.state.turn, ts: Date.now() },
      ],
    });
  }

  startTool(name: string, target?: string): string {
    const id = nid();
    const tool: ToolEntry = { id, name, target, status: 'running', startedAt: Date.now() };
    this.emit({
      ...this.state,
      items: [...this.state.items, { id, kind: 'tool', tool, turn: this.state.turn, ts: Date.now() }],
    });
    return id;
  }

  updateTool(id: string, patch: Partial<ToolEntry>): void {
    const items = this.state.items.map((it) => {
      if (it.id !== id || !it.tool) return it;
      return { ...it, tool: { ...it.tool, ...patch } };
    });
    this.emit({ ...this.state, items });
  }

  finishTool(id: string, status: 'ok' | 'err', patch: Partial<ToolEntry> = {}): void {
    this.updateTool(id, { ...patch, status, endedAt: Date.now() });
  }

  // ── status ops ────────────────────────────────────────────────────────

  // All setters are equality-guarded: if the new value equals the current
  // value, we skip the emit entirely. Without this, the polling refresh
  // (usage / busy / queue / mode every 500ms) fires re-renders of the
  // whole Ink tree 8+ times per second and the output flickers visibly.

  setThinking(label: string | null): void {
    if (this.state.thinking === label) return;
    this.emit({
      ...this.state,
      thinking: label,
      thinkingStartedAt: label ? Date.now() : null,
    });
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
    this.emit({ ...this.state, project: { branch, dirty } });
  }

  setOverlay(overlay: BridgeState['overlay']): void {
    // Reference equality covers null→null and the rare "same object passed
    // twice" case. We don't short-circuit on kind equality anymore because
    // the model-models overlay carries a `provider` field, and switching
    // from {kind:'model-models',provider:'anthropic'} to the same kind with
    // a different provider needs to re-emit so the picker re-renders.
    if (this.state.overlay === overlay) return;
    this.emit({ ...this.state, overlay });
  }

  setMcpStatus(s: McpStatusEntry[]): void {
    // Shallow compare — MCP status changes are rare (server connect/disconnect).
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

  // Start a new turn — bumps the counter, clears this-turn edits list.
  beginTurn(): void {
    this.emit({ ...this.state, turn: this.state.turn + 1, editsThisTurn: [] });
  }

  recordEdit(e: RailEditSummary): void {
    // Coalesce on file path so multiple edits to the same file show as one.
    const without = this.state.editsThisTurn.filter((x) => x.file !== e.file);
    this.emit({ ...this.state, editsThisTurn: [...without, e] });
  }

  // Reset everything — used by /clear.
  reset(): void {
    this.emit({
      ...INITIAL,
      mode: this.state.mode,
      mcpStatus: this.state.mcpStatus,
      project: this.state.project,
    });
  }
}
