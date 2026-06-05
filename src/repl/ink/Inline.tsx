// Inline.tsx — the flicker-free renderer (default).
//
// Append-only: committed history prints once into native scrollback via Ink
// <Static> and is never redrawn. Only a small live region at the bottom
// (busy line + bordered input + status) repaints. Per the Claude Design
// handoff, tuned for legibility on plain terminals (Git Bash / mintty):
//   - committed = user message, the agent's final answer, ONE compact line
//     per tool (consecutive same-tool calls consolidate), and edit diffs;
//   - ephemeral = the live spinner / current tool run, input, status bar;
//   - glyphs fall back to ASCII where the terminal can't render the fancy set.

import React from 'react';
import { Box, Text, Static } from 'ink';
import { basename } from 'node:path';
import type { BridgeState, TranscriptItem } from './store.js';
import { useTheme, type Theme } from './theme.js';
import { useTick, useTerminalSize } from './hooks.js';
import { StatusBar } from './StatusBar.js';
import { PlanPanel } from './PlanPanel.js';
import { Markdown } from './Markdown.js';
import { glyphs } from './glyphs.js';
import { WORDMARK, WORDMARK_COMPACT, TAGLINE, gradientSegments, hexToRgb } from '../Banner.js';

const DIFF_CAP = 24;

export interface InlineProps {
  state: BridgeState;
  input: string;
  cursor: number;
  spinnerId: string;
  overlay?: React.ReactNode;
  exitArmed?: boolean;
  projectRoot: string;
  version: string;
  modelProvider: string;
  modelName: string;
}

// A render entry: either a plain transcript item, or a consolidated run of
// consecutive same-name tools.
type Entry =
  | { type: 'item'; key: string; item: TranscriptItem }
  | { type: 'toolrun'; key: string; name: string; count: number; target?: string; failed: boolean };

type StaticEntry = { type: 'welcome'; key: string } | Entry;

export function Inline(props: InlineProps): React.JSX.Element {
  const t = useTheme();
  const g = glyphs();
  const { columns } = useTerminalSize();
  const { state } = props;

  // Hold the actively-running trailing run of same-name tools out of <Static>
  // (it's still changing); everything before it is committed.
  const { committed, liveRun } = splitLiveRun(state.items);
  const entries = groupEntries(committed);
  const staticItems: StaticEntry[] = [{ type: 'welcome', key: '__welcome__' }, ...entries];

  return (
    <Box flexDirection="column">
      <Static items={staticItems}>
        {(entry) =>
          entry.type === 'welcome' ? (
            <Welcome
              key={entry.key}
              t={t}
              version={props.version}
              provider={props.modelProvider}
              model={props.modelName}
              projectRoot={props.projectRoot}
              branch={state.project.branch}
              columns={columns}
            />
          ) : (
            <EntryRow key={entry.key} t={t} entry={entry} columns={columns} />
          )
        }
      </Static>

      {/* live region — the only part that repaints; kept small + stable */}
      <Box flexDirection="column" marginTop={1}>
        <ActivityLine t={t} state={state} liveRun={liveRun} columns={columns} />

        <PlanPanel items={state.plan.items} collapsed={state.plan.collapsed} />

        {props.overlay}

        {/* bordered prompt — a distinct zone, set off from the output */}
        <Box borderStyle="single" borderColor={t.ruleStrong} borderLeft={false} borderRight={false}>
          <Text color={t.accent} bold>{g.user} </Text>
          <Text color={t.ink}>{props.input.slice(0, props.cursor)}</Text>
          <Text backgroundColor={t.accent} color={t.cursorInk}>
            {props.input.slice(props.cursor, props.cursor + 1) || ' '}
          </Text>
          <Text color={t.ink}>{props.input.slice(props.cursor + 1)}</Text>
        </Box>

        <StatusBar state={state} columns={columns} />

        <Text color={t.inkFaint}>
          enter send · esc {state.busy ? 'interrupt' : 'clear'} · ^P plan · {g.rich ? '↑' : 'up'} history
          {' '}· ^c {props.exitArmed ? 'EXIT' : 'exit'}
        </Text>
      </Box>
    </Box>
  );
}

// ── committed entry rendering ────────────────────────────────────────────

function EntryRow({ t, entry, columns }: { t: Theme; entry: Entry; columns: number }): React.JSX.Element {
  if (entry.type === 'toolrun') {
    return <ToolLine t={t} name={entry.name} target={entry.target} count={entry.count} failed={entry.failed} columns={columns} />;
  }
  const item = entry.item;
  switch (item.kind) {
    case 'user':
      return (
        <Box marginTop={1}>
          <Text color={t.accent} bold>{glyphs().user} </Text>
          <Text color={t.ink} bold>{item.text ?? ''}</Text>
        </Box>
      );
    case 'assistant':
      return (
        <Box marginTop={1} flexGrow={1}>
          <Markdown text={item.text ?? ''} />
        </Box>
      );
    case 'info':
      return (
        <Box>
          <Text color={t.inkDim}>  {item.text ?? ''}</Text>
        </Box>
      );
    case 'warn':
      return (
        <Box>
          <Text color={t.warn}>  {glyphs().warn} {item.text ?? ''}</Text>
        </Box>
      );
    case 'error':
      return (
        <Box>
          <Text color={t.rose}>  {glyphs().error} {item.text ?? ''}</Text>
        </Box>
      );
    case 'tool':
      return item.tool ? (
        <ToolLine t={t} name={item.tool.name} target={item.tool.target} count={1} failed={item.tool.status === 'err'} columns={columns} />
      ) : (
        <></>
      );
    case 'diff':
      return item.diff ? <CommittedDiff t={t} before={item.diff.before} after={item.diff.after} /> : <></>;
    case 'rule':
      return <></>; // turn spacing comes from the user-message margin
    case 'thinking':
    case 'compact':
      return (
        <Box>
          <Text color={t.inkFaint}>  {item.text ?? ''}</Text>
        </Box>
      );
  }
}

function ToolLine({
  t,
  name,
  target,
  count,
  failed,
  columns,
}: {
  t: Theme;
  name: string;
  target?: string;
  count: number;
  failed: boolean;
  columns: number;
}): React.JSX.Element {
  const g = glyphs();
  const glyph = failed ? g.toolFail : g.toolDone;
  const glyphColor = failed ? t.rose : t.add;
  const room = Math.max(8, columns - name.length - 12);
  return (
    <Box>
      <Text color={glyphColor}>  {glyph} </Text>
      <Text color={t.accent}>{name}</Text>
      {count > 1 && <Text color={t.inkDim}> {g.times}{count}</Text>}
      {target && <Text color={t.inkDim}>  {truncate(target, room)}</Text>}
    </Box>
  );
}

function CommittedDiff({ t, before, after }: { t: Theme; before: string; after: string }): React.JSX.Element {
  if (before === after) return <></>;
  // Minimal line-level diff: show removed then added lines (capped).
  const removed = before.split('\n');
  const added = after.split('\n');
  const lines: Array<{ k: 'a' | 'd'; x: string }> = [];
  for (const l of removed) if (!added.includes(l) && l.length > 0) lines.push({ k: 'd', x: l });
  for (const l of added) if (!removed.includes(l) && l.length > 0) lines.push({ k: 'a', x: l });
  if (lines.length === 0) return <></>;
  const g = glyphs();
  const shown = lines.slice(0, DIFF_CAP);
  return (
    <Box flexDirection="column">
      {shown.map((l, i) => (
        <Box key={i}>
          <Text color={t.ruleStrong}>    {g.diffGuide} </Text>
          <Text color={l.k === 'a' ? t.add : t.del} backgroundColor={l.k === 'a' ? t.addBg : t.delBg}>
            {l.k === 'a' ? '+' : '-'} {l.x}
          </Text>
        </Box>
      ))}
      {lines.length > DIFF_CAP && (
        <Box>
          <Text color={t.inkFaint}>    {g.diffGuide} … +{lines.length - DIFF_CAP} more</Text>
        </Box>
      )}
    </Box>
  );
}

// ── live region pieces ───────────────────────────────────────────────────

function ActivityLine({
  t,
  state,
  liveRun,
  columns,
}: {
  t: Theme;
  state: BridgeState;
  liveRun: TranscriptItem[];
  columns: number;
}): React.JSX.Element | null {
  const g = glyphs();
  const frame = g.spinner[useTick(g.rich ? 90 : 130) % g.spinner.length]!;

  if (liveRun.length > 0) {
    const last = liveRun[liveRun.length - 1]!;
    const name = last.tool?.name ?? 'tool';
    const target = last.tool?.target;
    const room = Math.max(8, columns - name.length - 14);
    return (
      <Box>
        <Text color={t.amber}>{frame} </Text>
        <Text color={t.accent}>{name}</Text>
        {liveRun.length > 1 && <Text color={t.inkDim}> {g.times}{liveRun.length}</Text>}
        {target && <Text color={t.inkDim}>  {truncate(target, room)}</Text>}
      </Box>
    );
  }
  if (state.thinking) {
    return (
      <Box>
        <Text color={t.accent}>{frame} </Text>
        <Text color={t.inkDim}>{state.thinking}</Text>
      </Box>
    );
  }
  if (state.busy) {
    return (
      <Box>
        <Text color={t.accent}>{frame} </Text>
        <Text color={t.inkDim}>working</Text>
      </Box>
    );
  }
  return null;
}

function Welcome({
  t,
  version,
  provider,
  model,
  projectRoot,
  branch,
  columns,
}: {
  t: Theme;
  version: string;
  provider: string;
  model: string;
  projectRoot: string;
  branch: string | null;
  columns: number;
}): React.JSX.Element {
  const g = glyphs();
  // Big face when there's room (≥ 69 cols), else the 2-row compact face.
  const art = columns >= WORDMARK[0]!.length + 1 ? WORDMARK : WORDMARK_COMPACT;
  const width = art[0]!.length;
  // Theme-aware gradient: accent (teal) → agent (violet), painted natively as
  // per-color <Text> runs so it's safe inside <Static> (no embedded ANSI).
  const from = hexToRgb(t.accent);
  const to = hexToRgb(t.agent);
  return (
    <Box flexDirection="column">
      {art.map((row, r) => (
        <Box key={r}>
          {gradientSegments(row, width, from, to).map((s, i) => (
            <Text key={i} color={s.color}>{s.text}</Text>
          ))}
        </Box>
      ))}
      {/* tagline — version already carries its own leading 'v' */}
      <Box marginTop={1}>
        <Text color={t.inkFaint}>{TAGLINE}{'  ·  '}{version}</Text>
      </Box>
      {/* meta — wordmark + tagline cover name/version, so this drops them */}
      <Box marginTop={1}>
        <Text color={t.ink}>{provider}/{model}</Text>
        <Text color={t.inkFaint}>{'  ·  '}</Text>
        <Text color={t.inkDim}>{basename(projectRoot)}</Text>
        {branch && (
          <>
            <Text color={t.inkFaint}>{'  '}</Text>
            <Text color={t.inkDim}>{g.branch}</Text>
            <Text color={t.accent}>{branch}</Text>
          </>
        )}
      </Box>
      <Text color={t.inkFaint}>/help for commands · /model to switch · shift+tab cycles mode</Text>
    </Box>
  );
}

// ── helpers ──────────────────────────────────────────────────────────────

// Pull the actively-running trailing run of consecutive same-name tools out of
// the committed list so it stays in the live region (and consolidates) until
// it settles. If the last item isn't a running tool, nothing is live.
function splitLiveRun(items: TranscriptItem[]): { committed: TranscriptItem[]; liveRun: TranscriptItem[] } {
  const last = items[items.length - 1];
  if (!(last && last.kind === 'tool' && last.tool && last.tool.status === 'running')) {
    return { committed: items, liveRun: [] };
  }
  const name = last.tool.name;
  let i = items.length - 1;
  while (i >= 0) {
    const it = items[i]!;
    if (it.kind === 'tool' && it.tool && it.tool.name === name) i--;
    else break;
  }
  return { committed: items.slice(0, i + 1), liveRun: items.slice(i + 1) };
}

// Collapse consecutive same-name tool items into one run entry. These runs are
// complete (a non-matching item follows), so they're safe to freeze in <Static>.
function groupEntries(items: TranscriptItem[]): Entry[] {
  const out: Entry[] = [];
  let i = 0;
  while (i < items.length) {
    const it = items[i]!;
    if (it.kind === 'tool' && it.tool) {
      const name = it.tool.name;
      let j = i;
      let failed = false;
      let lastTarget: string | undefined;
      while (j < items.length) {
        const t = items[j]!;
        if (t.kind === 'tool' && t.tool && t.tool.name === name) {
          if (t.tool.status === 'err') failed = true;
          if (t.tool.target) lastTarget = t.tool.target;
          j++;
        } else break;
      }
      out.push({ type: 'toolrun', key: it.id, name, count: j - i, target: lastTarget, failed });
      i = j;
    } else {
      out.push({ type: 'item', key: it.id, item: it });
      i++;
    }
  }
  return out;
}

function truncate(s: string, n: number): string {
  if (n <= 1) return s.slice(0, Math.max(0, n));
  return s.length <= n ? s : s.slice(0, n - 1) + '…';
}
