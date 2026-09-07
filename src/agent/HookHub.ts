// One place that knows every hook a session has (Phase 4.5): the user's
// config, the project's .autocode/hooks.json (or the hooks key of a
// .claude/settings.json, so a repo set up for Claude Code works as is) and
// plugin hooks.json files — merged in that order — and one `fire` that runs
// them and reports their output to the user.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ConsoleRenderer } from '../repl/ConsoleRenderer.js';
import { getPlugins } from './Plugins.js';
import {
  HOOK_EVENTS,
  mergeHookMaps,
  normalizeHooks,
  runHooks,
  type HookEventName,
  type HookGroup,
  type HookInput,
  type HookOutcome,
  type HooksConfig,
} from './HookRunner.js';

export const PROJECT_HOOK_FILES = ['.autocode/hooks.json', '.claude/settings.json'];

export class HookHub {
  private groups: Map<HookEventName, HookGroup[]>;

  constructor(
    private readonly root: string,
    private readonly sessionId: string,
    opts: { config?: HooksConfig | null; renderer?: Pick<ConsoleRenderer, 'dim' | 'warn'>; includeProject?: boolean; includePlugins?: boolean } = {},
  ) {
    this.renderer = opts.renderer;
    this.groups = HookHub.load(root, opts.config ?? null, {
      includeProject: opts.includeProject ?? true,
      includePlugins: opts.includePlugins ?? true,
    });
  }

  private readonly renderer: Pick<ConsoleRenderer, 'dim' | 'warn'> | undefined;

  static load(root: string, config: HooksConfig | null, opts: { includeProject: boolean; includePlugins: boolean }): Map<HookEventName, HookGroup[]> {
    const maps = [normalizeHooks(config)];
    if (opts.includeProject) maps.push(readProjectHooks(root));
    if (opts.includePlugins) {
      for (const p of getPlugins(root)) maps.push(p.hookGroups);
    }
    return mergeHookMaps(...maps);
  }

  /** Events with at least one hook — for /hooks and the status line. */
  events(): HookEventName[] {
    return HOOK_EVENTS.filter((e) => (this.groups.get(e)?.length ?? 0) > 0);
  }

  has(event: HookEventName): boolean {
    return (this.groups.get(event)?.length ?? 0) > 0;
  }

  count(): number {
    let n = 0;
    for (const g of this.groups.values()) for (const group of g) n += group.hooks.length;
    return n;
  }

  /** Run the hooks for an event; never throws. Output lines reach the user. */
  async fire(event: HookEventName, input: Partial<Omit<HookInput, 'hook_event_name' | 'session_id' | 'cwd'>> = {}): Promise<HookOutcome[]> {
    const groups = this.groups.get(event);
    if (!groups || groups.length === 0) return [];
    let outcomes: HookOutcome[];
    try {
      outcomes = await runHooks(event, groups, { ...input, session_id: this.sessionId, cwd: this.root });
    } catch (e) {
      this.renderer?.warn(`hook[${event}] failed to run: ${e instanceof Error ? e.message : String(e)}`);
      return [];
    }
    for (const o of outcomes) {
      const tag = `hook[${event}]`;
      if (o.timedOut) this.renderer?.warn(`  ${tag} ${o.command} → timed out`);
      else if (o.exitCode !== 0 && !o.blocked) this.renderer?.warn(`  ${tag} ${o.command} → exit ${o.exitCode ?? '?'}`);
      if (o.systemMessage) this.renderer?.warn(`  ${tag}: ${o.systemMessage}`);
      const out = o.stdout.trim();
      if (out.length > 0 && !out.startsWith('{')) this.renderer?.dim(`  ${tag}: ${out}`);
      const err = o.stderr.trim();
      if (err.length > 0 && !o.blocked && o.exitCode !== 0) this.renderer?.dim(`  ${tag}: ${err}`);
    }
    return outcomes;
  }
}

/** Project-level hooks: `.autocode/hooks.json` (either shape) or `.claude/settings.json`'s `hooks`. */
export function readProjectHooks(root: string): Map<HookEventName, HookGroup[]> {
  for (const rel of PROJECT_HOOK_FILES) {
    const path = join(root, rel);
    if (!existsSync(path)) continue;
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
      const hooks = parsed && typeof parsed === 'object' && parsed['hooks'] && typeof parsed['hooks'] === 'object' ? (parsed['hooks'] as HooksConfig) : (parsed as HooksConfig);
      const map = normalizeHooks(hooks);
      if (map.size > 0) return map;
    } catch {
      /* malformed: ignore this file */
    }
  }
  return new Map();
}
