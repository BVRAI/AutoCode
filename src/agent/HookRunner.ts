// Hooks on Claude Code's contract (Phase 4.5).
//
// Config (user ~/.autocode/config.json `hooks`, project .autocode/hooks.json,
// plugin hooks.json) uses Claude Code's shape so hook sets are portable:
//
//   "hooks": {
//     "PreToolUse": [
//       { "matcher": "Bash(git *)|edit_file", "hooks": [{ "type": "command", "command": "…", "timeout": 30 }] }
//     ]
//   }
//
// Events: SessionStart, SessionEnd, UserPromptSubmit, PreToolUse,
// PermissionRequest, PostToolUse, PostToolUseFailure, SubagentStart,
// SubagentStop, Stop, PreCompact, PostCompact, Notification.
//
// A hook gets a JSON object on stdin (session_id, cwd, hook_event_name, and
// per-event fields such as tool_name / tool_input / tool_response / prompt),
// plus the legacy AUTOCODE_HOOK_* environment variables. Exit 0 with JSON on
// stdout can carry `hookSpecificOutput` (permissionDecision allow|deny|ask,
// permissionDecisionReason, updatedInput, additionalContext), `systemMessage`,
// `continue: false` + `stopReason`. Exit 2 blocks (PreToolUse, PermissionRequest,
// UserPromptSubmit) or asks the agent to keep going (Stop) with stderr as the
// reason. Any other non-zero exit is advisory.
//
// The legacy flat shape (`pre_tool` / `post_tool` / `stop` arrays with a
// `|`-separated `match`) keeps working and maps onto the same engine.

import { spawn, execSync } from 'node:child_process';

export type HookEventName =
  | 'SessionStart'
  | 'SessionEnd'
  | 'UserPromptSubmit'
  | 'PreToolUse'
  | 'PermissionRequest'
  | 'PostToolUse'
  | 'PostToolUseFailure'
  | 'SubagentStart'
  | 'SubagentStop'
  | 'Stop'
  | 'PreCompact'
  | 'PostCompact'
  | 'Notification';

export const HOOK_EVENTS: readonly HookEventName[] = [
  'SessionStart',
  'SessionEnd',
  'UserPromptSubmit',
  'PreToolUse',
  'PermissionRequest',
  'PostToolUse',
  'PostToolUseFailure',
  'SubagentStart',
  'SubagentStop',
  'Stop',
  'PreCompact',
  'PostCompact',
  'Notification',
];

/** Legacy event names (config `hooks.pre_tool` …). */
export type HookEvent = 'pre_tool' | 'post_tool' | 'stop';

/** Legacy flat spec. */
export interface HookSpec {
  /** `|`-separated list of exact tool names, or `*` (or absent) to match all. */
  match?: string;
  command: string;
  timeoutMs?: number;
}

export interface HookCommand {
  type?: 'command';
  command: string;
  /** Seconds (Claude Code's unit). */
  timeout?: number;
  /** Milliseconds (legacy). */
  timeoutMs?: number;
}

export interface HookGroup {
  /** Tool-name regex, or `Tool(prefix *)` for a command/path prefix; empty or `*` matches all. */
  matcher?: string;
  hooks: HookCommand[];
}

export type HooksConfig = Partial<Record<HookEventName, HookGroup[]>> & {
  pre_tool?: HookSpec[];
  post_tool?: HookSpec[];
  stop?: HookSpec[];
};

/** What a hook receives on stdin. */
export interface HookInput {
  session_id: string;
  cwd: string;
  hook_event_name: HookEventName;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  tool_response?: string;
  tool_error?: string;
  prompt?: string;
  subagent_type?: string;
  subagent_result?: string;
  trigger?: 'manual' | 'auto';
  stop_hook_active?: boolean;
  reason?: string;
  message?: string;
}

export interface HookOutcome {
  event: HookEventName;
  command: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
  /** Exit 2 on a blocking event, or a `deny` decision. */
  blocked: boolean;
  /** PreToolUse / PermissionRequest decision from stdout JSON. */
  decision?: 'allow' | 'deny' | 'ask';
  reason?: string;
  updatedInput?: Record<string, unknown>;
  additionalContext?: string;
  systemMessage?: string;
  /** `continue: false` in stdout JSON. */
  halt?: boolean;
  stopReason?: string;
}

/** Legacy context (env-based). */
export interface HookContext {
  event: HookEvent;
  toolName?: string;
  toolArgs?: Record<string, unknown>;
  toolResultText?: string;
  toolResultIsError?: boolean;
  projectRoot: string;
  sessionId: string;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const OUTPUT_CAP_BYTES = 16 * 1024;
const TOOL_RESULT_CAP_BYTES = 8 * 1024;
const BLOCKING_EVENTS = new Set<HookEventName>(['PreToolUse', 'PermissionRequest', 'UserPromptSubmit', 'Stop', 'SubagentStop']);

/** Claude Code's tool names → ours, so `Bash(git *)` matchers port unchanged. */
const TOOL_ALIASES: Record<string, string> = {
  bash: 'run_shell',
  read: 'read_file',
  edit: 'edit_file',
  write: 'write_file',
  glob: 'glob',
  grep: 'grep',
  webfetch: 'web_fetch',
  websearch: 'web_search',
  task: 'task',
  todowrite: 'todo_write',
};

const LEGACY_EVENT: Record<HookEvent, HookEventName> = { pre_tool: 'PreToolUse', post_tool: 'PostToolUse', stop: 'SessionEnd' };

// ── config ──────────────────────────────────────────────────────────────────

/** Bring every accepted shape to `event → groups`. */
export function normalizeHooks(config: HooksConfig | undefined | null): Map<HookEventName, HookGroup[]> {
  const out = new Map<HookEventName, HookGroup[]>();
  if (!config || typeof config !== 'object') return out;
  const add = (event: HookEventName, groups: HookGroup[]): void => {
    if (groups.length === 0) return;
    out.set(event, [...(out.get(event) ?? []), ...groups]);
  };
  for (const legacy of ['pre_tool', 'post_tool', 'stop'] as const) {
    const specs = config[legacy];
    if (!Array.isArray(specs)) continue;
    add(
      LEGACY_EVENT[legacy],
      specs
        .filter((s): s is HookSpec => Boolean(s) && typeof (s as HookSpec).command === 'string')
        .map((s) => ({ matcher: legacyMatcher(s.match), hooks: [{ type: 'command', command: s.command, timeoutMs: s.timeoutMs }] })),
    );
  }
  for (const event of HOOK_EVENTS) {
    const groups = (config as Record<string, unknown>)[event];
    if (!Array.isArray(groups)) continue;
    const clean: HookGroup[] = [];
    for (const g of groups) {
      if (!g || typeof g !== 'object') continue;
      const group = g as Record<string, unknown>;
      const hooks = Array.isArray(group['hooks'])
        ? (group['hooks'] as unknown[]).filter((h): h is HookCommand => Boolean(h) && typeof (h as HookCommand).command === 'string')
        : typeof group['command'] === 'string'
          ? [{ command: group['command'] as string, timeout: typeof group['timeout'] === 'number' ? (group['timeout'] as number) : undefined }]
          : [];
      if (hooks.length === 0) continue;
      clean.push({ matcher: typeof group['matcher'] === 'string' ? group['matcher'] : undefined, hooks });
    }
    add(event, clean);
  }
  return out;
}

function legacyMatcher(match: string | undefined): string | undefined {
  const m = match?.trim();
  if (!m || m === '*') return undefined;
  return `^(?:${m.split('|').map((s) => escapeRe(s.trim())).join('|')})$`;
}

export function mergeHookMaps(...maps: Array<Map<HookEventName, HookGroup[]>>): Map<HookEventName, HookGroup[]> {
  const out = new Map<HookEventName, HookGroup[]>();
  for (const m of maps) for (const [event, groups] of m) out.set(event, [...(out.get(event) ?? []), ...groups]);
  return out;
}

// ── matching ────────────────────────────────────────────────────────────────

/**
 * Does a matcher apply to this tool call? Empty / `*` → yes. `Tool(prefix *)`
 * → the tool (alias-aware) and, for shell, a command prefix; for file tools a
 * path prefix. Anything else is a regex over the tool name (aliases resolved
 * on both sides), anchored.
 */
export function matcherMatches(matcher: string | undefined, toolName: string | undefined, toolInput?: Record<string, unknown>): boolean {
  const m = matcher?.trim();
  if (!m || m === '*') return true;
  if (toolName === undefined) return false;
  const tool = canonicalTool(toolName);
  // Alternatives of Tool(prefix *) forms and plain names.
  const alternatives = splitTopLevel(m);
  for (const alt of alternatives) {
    const prefixForm = /^([A-Za-z_][\w-]*)\((.*)\)$/.exec(alt.trim());
    if (prefixForm) {
      if (canonicalTool(prefixForm[1]!) !== tool) continue;
      const pattern = prefixForm[2]!.trim();
      const subject = subjectOf(tool, toolInput);
      if (pattern === '' || pattern === '*') return true;
      if (pattern.endsWith('*')) {
        if (subject.startsWith(pattern.slice(0, -1))) return true;
      } else if (subject === pattern) return true;
      continue;
    }
    try {
      const re = new RegExp(`^(?:${alt.trim()})$`, 'i');
      if (re.test(toolName) || re.test(tool)) return true;
      // Alias written in the matcher (Edit|Write) against our name.
      const aliased = canonicalTool(alt.trim());
      if (aliased === tool) return true;
    } catch {
      if (alt.trim().toLowerCase() === toolName.toLowerCase()) return true;
    }
  }
  return false;
}

/** Legacy: does a flat spec apply to the given tool name? */
export function hookMatches(spec: HookSpec, toolName: string | undefined): boolean {
  const m = spec.match?.trim();
  if (!m || m === '*') return true;
  if (toolName === undefined) return false;
  return m.split('|').some((s) => s.trim() === toolName);
}

function canonicalTool(name: string): string {
  const key = name.replace(/[_-]/g, '').toLowerCase();
  return TOOL_ALIASES[key] ?? name;
}

function subjectOf(tool: string, input: Record<string, unknown> | undefined): string {
  if (!input) return '';
  if (tool === 'run_shell') return typeof input['command'] === 'string' ? (input['command'] as string).trim() : '';
  for (const k of ['path', 'file', 'file_path', 'pattern', 'url', 'query', 'name']) {
    if (typeof input[k] === 'string') return (input[k] as string).replace(/\\/g, '/');
  }
  return '';
}

/** Split on `|` that are not inside parentheses. */
function splitTopLevel(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of s) {
    if (ch === '(') depth += 1;
    else if (ch === ')') depth = Math.max(0, depth - 1);
    if (ch === '|' && depth === 0) {
      out.push(cur);
      cur = '';
      continue;
    }
    cur += ch;
  }
  out.push(cur);
  return out.filter((p) => p.trim().length > 0);
}

// ── running ─────────────────────────────────────────────────────────────────

/** Run every matching hook for an event, in order. Never throws. */
export async function runHooks(event: HookEventName, groups: HookGroup[] | undefined, input: Omit<HookInput, 'hook_event_name'>): Promise<HookOutcome[]> {
  if (!groups || groups.length === 0) return [];
  const full: HookInput = { ...input, hook_event_name: event };
  const outcomes: HookOutcome[] = [];
  for (const group of groups) {
    if (!matcherMatches(group.matcher, input.tool_name, input.tool_input)) continue;
    for (const hook of group.hooks) {
      outcomes.push(await runOne(event, hook, full));
    }
  }
  return outcomes;
}

/** Legacy entry point: flat specs + env context. */
export async function runHooksForEvent(specs: HookSpec[] | undefined, ctx: HookContext): Promise<HookOutcome[]> {
  if (!specs || specs.length === 0) return [];
  const event = LEGACY_EVENT[ctx.event];
  const outcomes: HookOutcome[] = [];
  for (const spec of specs) {
    if (ctx.event !== 'stop' && !hookMatches(spec, ctx.toolName)) continue;
    outcomes.push(
      await runOne(
        event,
        { command: spec.command, timeoutMs: spec.timeoutMs },
        {
          hook_event_name: event,
          session_id: ctx.sessionId,
          cwd: ctx.projectRoot,
          tool_name: ctx.toolName,
          tool_input: ctx.toolArgs,
          tool_response: ctx.toolResultText,
          tool_error: ctx.toolResultIsError ? ctx.toolResultText : undefined,
        },
        ctx.event === 'pre_tool',
      ),
    );
  }
  return outcomes;
}

function runOne(event: HookEventName, hook: HookCommand, input: HookInput, legacyBlocking?: boolean): Promise<HookOutcome> {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const timeoutMs = hook.timeoutMs ?? (typeof hook.timeout === 'number' ? hook.timeout * 1000 : DEFAULT_TIMEOUT_MS);
    const env = buildHookEnv(input);
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    const blockingEvent = legacyBlocking ?? BLOCKING_EVENTS.has(event);

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(hook.command, {
        cwd: input.cwd,
        shell: true,
        env: { ...process.env, ...env },
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
      });
    } catch (e) {
      resolve({ event, command: hook.command, exitCode: null, stdout: '', stderr: `[hook spawn error] ${e instanceof Error ? e.message : String(e)}`, timedOut: false, durationMs: 0, blocked: false });
      return;
    }

    const timer = setTimeout(() => {
      timedOut = true;
      treeKill(child.pid);
      setTimeout(() => finish(null), 1500);
    }, timeoutMs);

    child.stdout?.on('data', (d: Buffer) => {
      if (stdout.length < OUTPUT_CAP_BYTES) stdout += d.toString('utf8');
    });
    child.stderr?.on('data', (d: Buffer) => {
      if (stderr.length < OUTPUT_CAP_BYTES) stderr += d.toString('utf8');
    });

    const finish = (code: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const trimmed = (s: string): string => (s.length > OUTPUT_CAP_BYTES ? s.slice(0, OUTPUT_CAP_BYTES) + `\n[…hook output truncated at ${OUTPUT_CAP_BYTES} bytes]` : s);
      const outcome: HookOutcome = {
        event,
        command: hook.command,
        exitCode: code,
        stdout: trimmed(stdout),
        stderr: trimmed(stderr),
        timedOut,
        durationMs: Date.now() - t0,
        blocked: blockingEvent && code === 2,
      };
      if (code === 0) applyStdoutJson(outcome, stdout, blockingEvent);
      resolve(outcome);
    };

    child.on('error', (err) => {
      stderr += `\n[hook spawn error] ${err.message}`;
      finish(null);
    });
    child.on('close', (code) => finish(code));

    try {
      child.stdin?.on('error', () => undefined);
      child.stdin?.end(JSON.stringify(input));
    } catch {
      /* a hook that never reads stdin */
    }
  });
}

/** Parse the structured stdout of a successful hook, tolerating plain text. */
export function applyStdoutJson(outcome: HookOutcome, stdout: string, blockingEvent: boolean): void {
  const text = stdout.trim();
  if (!text.startsWith('{')) return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return;
  }
  if (!parsed || typeof parsed !== 'object') return;
  const o = parsed as Record<string, unknown>;
  if (o['continue'] === false) {
    outcome.halt = true;
    if (typeof o['stopReason'] === 'string') outcome.stopReason = o['stopReason'];
  }
  if (typeof o['systemMessage'] === 'string') outcome.systemMessage = o['systemMessage'];
  const specific = o['hookSpecificOutput'];
  if (specific && typeof specific === 'object') {
    const s = specific as Record<string, unknown>;
    const decision = s['permissionDecision'];
    if (decision === 'allow' || decision === 'deny' || decision === 'ask') {
      outcome.decision = decision;
      if (decision === 'deny' && blockingEvent) outcome.blocked = true;
    }
    if (typeof s['permissionDecisionReason'] === 'string') outcome.reason = s['permissionDecisionReason'];
    if (s['updatedInput'] && typeof s['updatedInput'] === 'object') outcome.updatedInput = s['updatedInput'] as Record<string, unknown>;
    if (typeof s['additionalContext'] === 'string' && s['additionalContext'].trim()) outcome.additionalContext = s['additionalContext'];
  }
  // Top-level `decision: "block"` + `reason` (Claude Code's older/simple form).
  if (o['decision'] === 'block' || o['decision'] === 'deny') {
    outcome.blocked = blockingEvent;
    if (typeof o['reason'] === 'string') outcome.reason = o['reason'];
  }
}

// ── outcome helpers ─────────────────────────────────────────────────────────

/** Why the call/prompt/stop was blocked, or null. */
export function blockingReason(outcomes: HookOutcome[]): string | null {
  const blockers = outcomes.filter((o) => o.blocked);
  if (blockers.length === 0) return null;
  return blockers
    .map((o) => {
      const why = o.reason?.trim() || o.stderr.trim() || o.stdout.trim() || '(no message)';
      return `Hook \`${o.command}\` blocked this: ${why}`;
    })
    .join('\n\n');
}

/** The strongest permission decision across outcomes: deny > ask > allow. */
export function permissionDecision(outcomes: HookOutcome[]): { decision: 'allow' | 'deny' | 'ask' | null; reason?: string } {
  let best: 'allow' | 'deny' | 'ask' | null = null;
  let reason: string | undefined;
  const rank = { deny: 3, ask: 2, allow: 1 };
  for (const o of outcomes) {
    if (!o.decision) continue;
    if (!best || rank[o.decision] > rank[best]) {
      best = o.decision;
      reason = o.reason;
    }
  }
  return { decision: best, reason };
}

/** Last updatedInput wins. */
export function updatedInput(outcomes: HookOutcome[]): Record<string, unknown> | undefined {
  let out: Record<string, unknown> | undefined;
  for (const o of outcomes) if (o.updatedInput) out = o.updatedInput;
  return out;
}

export function additionalContext(outcomes: HookOutcome[]): string[] {
  return outcomes.map((o) => o.additionalContext?.trim() ?? '').filter((s) => s.length > 0);
}

export function systemMessages(outcomes: HookOutcome[]): string[] {
  return outcomes.map((o) => o.systemMessage?.trim() ?? '').filter((s) => s.length > 0);
}

// ── plumbing ────────────────────────────────────────────────────────────────

function treeKill(pid: number | undefined): void {
  if (pid === undefined) return;
  if (process.platform === 'win32') {
    try {
      execSync(`taskkill /pid ${pid} /T /F`, { stdio: 'ignore', windowsHide: true });
    } catch {
      /* may already be dead */
    }
    return;
  }
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* ignore */
    }
  }
}

function buildHookEnv(input: HookInput): Record<string, string> {
  const legacyEvent = input.hook_event_name === 'PreToolUse' ? 'pre_tool' : input.hook_event_name === 'PostToolUse' ? 'post_tool' : input.hook_event_name === 'SessionEnd' ? 'stop' : input.hook_event_name;
  const out: Record<string, string> = {
    AUTOCODE_HOOK_EVENT: legacyEvent,
    AUTOCODE_HOOK_EVENT_NAME: input.hook_event_name,
    AUTOCODE_HOOK_PROJECT_ROOT: input.cwd,
    AUTOCODE_HOOK_SESSION_ID: input.session_id,
  };
  if (input.tool_name !== undefined) out.AUTOCODE_HOOK_TOOL_NAME = input.tool_name;
  if (input.tool_input !== undefined) {
    try {
      out.AUTOCODE_HOOK_TOOL_ARGS_JSON = JSON.stringify(input.tool_input);
    } catch {
      out.AUTOCODE_HOOK_TOOL_ARGS_JSON = '{}';
    }
  }
  if (input.tool_response !== undefined) out.AUTOCODE_HOOK_TOOL_RESULT = input.tool_response.slice(0, TOOL_RESULT_CAP_BYTES);
  if (input.tool_error !== undefined) out.AUTOCODE_HOOK_TOOL_RESULT_IS_ERROR = '1';
  else if (input.tool_response !== undefined) out.AUTOCODE_HOOK_TOOL_RESULT_IS_ERROR = '0';
  if (input.prompt !== undefined) out.AUTOCODE_HOOK_PROMPT = input.prompt.slice(0, TOOL_RESULT_CAP_BYTES);
  return out;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
