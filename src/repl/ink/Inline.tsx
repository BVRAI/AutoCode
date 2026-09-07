// Inline.tsx — the default renderer: Claude Code's transcript grammar in
// native scrollback.
//
// Committed history prints once into scrollback via Ink <Static> and is never
// redrawn; only the live region at the bottom repaints. What commits and what
// stays transient follows Claude Code exactly:
//   committed  — the user turn (tinted band), tool rows with their collapsed
//                result row, the thinking stub, the streamed answer, notices,
//                the end-of-turn duration line;
//   transient  — the status line (verb · elapsed · tokens · esc to interrupt),
//                the live thinking/answer text, the running tool row, the todo
//                tray, dialogs, the composer and the footer.

import React from 'react';
import { Box, Text, Static } from 'ink';
import { basename } from 'node:path';
import type { BridgeState, ToolEntry, TranscriptItem } from './store.js';
import { useTheme, type Theme } from './theme.js';
import { useTick, useTerminalSize } from './hooks.js';
import { StatusBar } from './StatusBar.js';
import { PlanPanel } from './PlanPanel.js';
import { Markdown } from './Markdown.js';
import { glyphs } from './glyphs.js';
import { cursorToRowCol } from './composerText.js';
import { WORDMARK_COMPACT, gradientSegments, hexToRgb } from '../Banner.js';
import {
  DONE_VERBS,
  diffRows,
  formatClock,
  formatDuration,
  formatTokens,
  shortName,
  truncateMiddle,
  verbFor,
  wrapPad,
  type DiffRow,
} from './grammar.js';

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

// A committed entry: a plain item, or a run of consecutive same-group tool
// rows collapsed into one ("Read 3 files").
type Entry =
  | { type: 'item'; key: string; item: TranscriptItem }
  | { type: 'toolgroup'; key: string; tools: ToolEntry[] };

type StaticEntry = { type: 'welcome'; key: string } | Entry;

const RESULT_INDENT = '     '; // under "⏺ " + "⎿  "

export function Inline(props: InlineProps): React.JSX.Element {
  const t = useTheme();
  const { columns } = useTerminalSize();
  const { state } = props;

  const { committed, live } = splitLive(state.items);
  const entries = groupEntries(committed);
  const liveGroup = liveReadGroup(live);
  const liveEntries = liveGroup ? [] : groupEntries(live);
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

      {/* live region — the only part that repaints */}
      <Box flexDirection="column">
        {liveGroup ? (
          <LiveGroupRow t={t} tools={liveGroup} columns={columns} />
        ) : (
          liveEntries.map((entry) =>
            entry.type === 'item' && entry.item.kind === 'tool' && entry.item.tool?.status === 'running' ? (
              <ToolRow key={entry.key} t={t} tool={entry.item.tool} columns={columns} live />
            ) : (
              <EntryRow key={entry.key} t={t} entry={entry} columns={columns} />
            ),
          )
        )}
        {state.thinkingLive && <ThinkingLive t={t} text={state.thinkingLive.text} since={state.thinkingLive.since} />}
        {state.streaming && (
          <Box marginTop={1}>
            <Text color={t.ink}>{glyphs().bullet} </Text>
            <Box width={Math.max(10, columns - 2)}>
              <Markdown text={state.streaming} />
            </Box>
          </Box>
        )}
        <StatusLine t={t} state={state} />

        <PlanPanel items={state.plan.items} collapsed={state.plan.collapsed} />

        {props.overlay}

        <Composer t={t} state={state} input={props.input} cursor={props.cursor} columns={columns} />

        <StatusBar state={state} columns={columns} exitArmed={props.exitArmed ?? false} />
      </Box>
    </Box>
  );
}

// ── committed entries ─────────────────────────────────────────────────────

function EntryRow({ t, entry, columns }: { t: Theme; entry: Entry; columns: number }): React.JSX.Element {
  if (entry.type === 'toolgroup') return <ToolGroupRow t={t} tools={entry.tools} columns={columns} />;
  const item = entry.item;
  const g = glyphs();
  switch (item.kind) {
    case 'user':
      return <UserBand t={t} text={item.text ?? ''} columns={columns} />;
    case 'assistant':
      return (
        <Box marginTop={1}>
          <Text color={t.ink}>{g.bullet} </Text>
          {/* An explicit width: a flex box next to the prefix lets the text wrap at
              the full terminal width, and the terminal then breaks the last word. */}
          <Box width={Math.max(10, columns - 2)}>
            <Markdown text={item.text ?? ''} />
          </Box>
        </Box>
      );
    case 'thinking':
      return (
        <Box marginTop={1}>
          <Text color={t.inkDim}>
            {g.star} Thought for {formatDuration(item.durationMs ?? 0)}
          </Text>
        </Box>
      );
    case 'turn_end': {
      const info = item.turnEnd;
      const verb = verbFor(DONE_VERBS, item.turn);
      const when = info ? formatClock(new Date(info.endedAt)) : '';
      return (
        <Box marginTop={1}>
          <Text color={t.inkDim}>
            {g.star} {verb} for {formatDuration(item.durationMs ?? 0)}
            {when ? ` · done ${when}` : ''}
          </Text>
        </Box>
      );
    }
    case 'info':
    case 'compact':
      return (
        <Box>
          <Text color={t.inkDim}>  {item.text ?? ''}</Text>
        </Box>
      );
    case 'warn':
      return (
        <Box>
          <Text color={t.warn}>
            {'  '}{g.warn} {item.text ?? ''}
          </Text>
        </Box>
      );
    case 'error':
      return (
        <Box>
          <Text color={t.rose}>
            {'  '}{g.error} {item.text ?? ''}
          </Text>
        </Box>
      );
    case 'tool':
      return item.tool ? <ToolRow t={t} tool={item.tool} columns={columns} /> : <></>;
    case 'diff':
      return item.diff ? (
        <StandaloneDiff t={t} label={item.diff.label} before={item.diff.before} after={item.diff.after} columns={columns} />
      ) : (
        <></>
      );
    case 'rule':
      return <></>;
  }
}

function UserBand({ t, text, columns }: { t: Theme; text: string; columns: number }): React.JSX.Element {
  const width = Math.max(10, columns - 2);
  const lines = wrapPad(text, width - 3);
  return (
    <Box flexDirection="column" marginTop={1}>
      {lines.map((l, i) => (
        <Text key={i} backgroundColor={t.userBand} color={t.ink}>
          {` ${i === 0 ? '> ' : '  '}${l}`}
        </Text>
      ))}
    </Box>
  );
}

/** One tool row: "⏺ Label(arg)" then "⎿  summary" and whatever hangs under it. */
function ToolRow({ t, tool, columns, live }: { t: Theme; tool: ToolEntry; columns: number; live?: boolean }): React.JSX.Element {
  const g = glyphs();
  const bulletColor = tool.status === 'err' ? t.rose : tool.status === 'running' ? t.inkDim : t.add;
  const room = Math.max(12, columns - tool.label.length - 6);
  const arg = tool.arg ? truncateMiddle(tool.arg, room) : '';
  return (
    <Box flexDirection="column">
      <Box>
        <Text color={bulletColor}>{g.bullet} </Text>
        <Text color={t.ink} bold>
          {tool.label}
        </Text>
        {arg.length > 0 && (
          <Text color={t.ink}>
            (<Text color={t.inkDim}>{arg}</Text>)
          </Text>
        )}
      </Box>
      {live ? <LiveResult t={t} tool={tool} /> : <ToolResult t={t} tool={tool} columns={columns} />}
    </Box>
  );
}

function LiveResult({ t, tool }: { t: Theme; tool: ToolEntry }): React.JSX.Element {
  const g = glyphs();
  useTick(1000);
  const secs = Math.max(0, Math.round((Date.now() - tool.startedAt) / 1000));
  return (
    <Box>
      <Text color={t.inkDim}>
        {'  '}{g.elbow}  Running… ({secs}s)
      </Text>
    </Box>
  );
}

function ToolResult({ t, tool, columns }: { t: Theme; tool: ToolEntry; columns: number }): React.JSX.Element {
  const g = glyphs();
  const errColor = tool.status === 'err' ? t.rose : t.inkDim;
  const rows: React.ReactNode[] = [];

  if (tool.summary && tool.summary.length > 0) {
    rows.push(
      <Box key="summary">
        <Text color={errColor}>
          {'  '}{g.elbow}  {tool.summary}
        </Text>
      </Box>,
    );
  }
  if (tool.todos && tool.todos.length > 0) {
    tool.todos.forEach((todo, i) => {
      const done = todo.status === 'completed';
      const mark = done ? g.checked : g.unchecked;
      rows.push(
        <Box key={`todo-${i}`}>
          <Text color={t.inkDim}>
            {'  '}{i === 0 && !tool.summary ? g.elbow : ' '}{'  '}
          </Text>
          <Text color={done ? t.inkDim : t.ink} strikethrough={done}>
            {mark} {todo.text}
          </Text>
        </Box>,
      );
    });
  }
  if (tool.bodyLines && tool.bodyLines.length > 0) {
    const width = Math.max(20, columns - RESULT_INDENT.length - 1);
    tool.bodyLines.forEach((line, i) => {
      const first = i === 0 && !tool.summary;
      rows.push(
        <Box key={`body-${i}`}>
          <Text color={t.inkDim}>
            {'  '}{first ? g.elbow : ' '}{'  '}
          </Text>
          <Text color={tool.status === 'err' ? t.rose : t.inkDim}>{line.length > width ? `${line.slice(0, width - 1)}…` : line}</Text>
        </Box>,
      );
    });
    if ((tool.hiddenLines ?? 0) > 0) {
      rows.push(
        <Box key="hidden">
          <Text color={t.inkDim}>
            {RESULT_INDENT}… +{tool.hiddenLines} lines (ctrl+o to expand)
          </Text>
        </Box>,
      );
    }
  }
  if (tool.diffRows && tool.diffRows.length > 0) {
    rows.push(<DiffBlock key="diff" t={t} rows={tool.diffRows} hidden={tool.diffHidden ?? 0} columns={columns} />);
  }
  if (rows.length === 0 && tool.status !== 'running') {
    rows.push(
      <Box key="done">
        <Text color={errColor}>
          {'  '}{g.elbow}  {tool.status === 'err' ? 'Error' : 'Done'}
        </Text>
      </Box>,
    );
  }
  return <Box flexDirection="column">{rows}</Box>;
}

/** Consecutive reads/lists collapse: "⏺ Read 3 files (ctrl+o to expand)" + the names. */
function ToolGroupRow({ t, tools, columns }: { t: Theme; tools: ToolEntry[]; columns: number }): React.JSX.Element {
  const g = glyphs();
  const failed = tools.some((x) => x.status === 'err');
  const kind = tools[0]!.group;
  const n = tools.length;
  const head = kind === 'read' ? `Read ${n} files` : kind === 'list' ? `Listed ${n} directories` : `Searched ${n} times`;
  const names = tools.map((x) => shortName(x.arg)).filter(Boolean);
  const width = Math.max(20, columns - RESULT_INDENT.length - 1);
  const joined = names.join(', ');
  return (
    <Box flexDirection="column">
      <Box>
        <Text color={failed ? t.rose : t.add}>{g.bullet} </Text>
        <Text color={t.ink} bold>
          {head}
        </Text>
        <Text color={t.inkDim}> (ctrl+o to expand)</Text>
      </Box>
      <Box>
        <Text color={t.inkDim}>
          {'  '}{g.elbow}  {joined.length > width ? `${joined.slice(0, width - 1)}…` : joined}
        </Text>
      </Box>
    </Box>
  );
}

/** While reads are in flight: "⏺ Reading 3 files… (ctrl+o to expand)" + the names so far. */
function LiveGroupRow({ t, tools, columns }: { t: Theme; tools: ToolEntry[]; columns: number }): React.JSX.Element {
  const g = glyphs();
  const kind = tools[0]!.group;
  const n = tools.length;
  const head = kind === 'read' ? `Reading ${n} files…` : `Listing ${n} directories…`;
  const names = tools.map((x) => shortName(x.arg)).filter(Boolean).join(', ');
  const width = Math.max(20, columns - RESULT_INDENT.length - 1);
  return (
    <Box flexDirection="column">
      <Box>
        <Text color={t.inkDim}>{g.bullet} </Text>
        <Text color={t.ink} bold>
          {head}
        </Text>
        <Text color={t.inkDim}> (ctrl+o to expand)</Text>
      </Box>
      <Box>
        <Text color={t.inkDim}>
          {'  '}{g.elbow}  {names.length > width ? `${names.slice(0, width - 1)}…` : names}
        </Text>
      </Box>
    </Box>
  );
}

function DiffBlock({ t, rows, hidden, columns }: { t: Theme; rows: DiffRow[]; hidden: number; columns: number }): React.JSX.Element {
  const g = glyphs();
  const width = Math.max(20, columns - 12);
  return (
    <Box flexDirection="column">
      {rows.map((r, i) => {
        if (r.kind === 'gap') {
          return (
            <Box key={i}>
              <Text color={t.inkDim}>
                {RESULT_INDENT}{g.ellipsisV}
              </Text>
            </Box>
          );
        }
        const no = (r.kind === 'del' ? r.oldNo : r.newNo) ?? r.oldNo ?? 0;
        const sign = r.kind === 'add' ? '+' : r.kind === 'del' ? '-' : ' ';
        const text = r.text.length > width ? `${r.text.slice(0, width - 1)}…` : r.text;
        const fg = r.kind === 'add' ? t.add : r.kind === 'del' ? t.del : t.inkDim;
        const bg = r.kind === 'add' ? t.addBg : r.kind === 'del' ? t.delBg : undefined;
        return (
          <Box key={i}>
            <Text color={t.inkDim}>
              {RESULT_INDENT}{String(no).padStart(4)}{' '}
            </Text>
            <Text color={fg} backgroundColor={bg}>
              {sign} {text}
            </Text>
          </Box>
        );
      })}
      {hidden > 0 && (
        <Box>
          <Text color={t.inkDim}>
            {RESULT_INDENT}… +{hidden} lines (ctrl+o to expand)
          </Text>
        </Box>
      )}
    </Box>
  );
}

function StandaloneDiff({ t, label, before, after, columns }: { t: Theme; label: string; before: string; after: string; columns: number }): React.JSX.Element {
  const g = glyphs();
  const { rows, stats, hidden } = diffRows(before, after, 24);
  if (rows.length === 0) return <></>;
  return (
    <Box flexDirection="column">
      <Box>
        <Text color={t.add}>{g.bullet} </Text>
        <Text color={t.ink} bold>
          Update
        </Text>
        <Text color={t.ink}>
          (<Text color={t.inkDim}>{label}</Text>)
        </Text>
      </Box>
      <Box>
        <Text color={t.inkDim}>
          {'  '}{g.elbow}  Updated {label} with {stats.added} addition{stats.added === 1 ? '' : 's'} and {stats.removed} removal{stats.removed === 1 ? '' : 's'}
        </Text>
      </Box>
      <DiffBlock t={t} rows={rows} hidden={hidden} columns={columns} />
    </Box>
  );
}

// ── live region ───────────────────────────────────────────────────────────

function ThinkingLive({ t, text, since }: { t: Theme; text: string; since: number }): React.JSX.Element {
  const g = glyphs();
  useTick(1000);
  const secs = Math.max(0, Math.round((Date.now() - since) / 1000));
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .slice(-4);
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text color={t.inkDim}>
        {g.star} Thinking… ({secs}s)
      </Text>
      {lines.map((l, i) => (
        <Text key={i} color={t.thinkingInk} italic>
          {'  '}{l}
        </Text>
      ))}
    </Box>
  );
}

/** "✽ Cogitating… (23s · ↓ 1.2k tokens · esc to interrupt)" — transient. */
function StatusLine({ t, state }: { t: Theme; state: BridgeState }): React.JSX.Element | null {
  const g = glyphs();
  const tick = useTick(200);
  if (!state.busy || !state.activity) return null;
  const frame = g.stars[tick % g.stars.length]!;
  const elapsedMs = Date.now() - (state.turnStartedAt ?? state.activity.since);
  const tokens = Math.round(state.liveOutputChars / 4);
  const color = elapsedMs > 10_000 ? t.amber : t.accent;
  return (
    <Box marginTop={1}>
      <Text color={color}>{frame} </Text>
      <Text color={t.ink}>{state.activity.verb}…</Text>
      <Text color={t.inkDim}>
        {' '}({formatDuration(elapsedMs)}
        {tokens > 0 ? ` · ${g.down} ${formatTokens(tokens)} tokens` : ''}
        {state.effort ? ` · ${state.effort}` : ''} · esc to interrupt)
      </Text>
    </Box>
  );
}

function Composer({ t, state, input, cursor, columns }: { t: Theme; state: BridgeState; input: string; cursor: number; columns: number }): React.JSX.Element {
  const borderColor =
    state.mode === 'planning' ? t.borderPlan : state.mode === 'autocode' || state.mode === 'admin' ? t.borderAuto : t.border;
  const shell = input.startsWith('!');
  const prefixColor = shell ? t.warn : t.accent;
  // Multi-line input: `\` + Enter (or a short paste) adds lines; the cursor
  // is drawn on the line it sits in.
  const lines = input.split('\n');
  const { row, col } = cursorToRowCol(input, cursor);
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={shell ? t.warn : borderColor}
      paddingX={1}
      marginTop={1}
      width={Math.max(20, columns)}
    >
      {lines.map((line, i) => {
        const prefix = i === 0 ? (shell ? '! ' : '> ') : '  ';
        const text = i === 0 && shell ? line.slice(1) : line;
        const c = Math.max(0, i === 0 && shell ? col - 1 : col);
        if (i !== row) {
          return (
            <Text key={i}>
              <Text color={prefixColor} bold>
                {prefix}
              </Text>
              <Text color={t.ink}>{text}</Text>
            </Text>
          );
        }
        return (
          <Text key={i}>
            <Text color={prefixColor} bold>
              {prefix}
            </Text>
            <Text color={t.ink}>{text.slice(0, c)}</Text>
            <Text backgroundColor={t.accent} color={t.cursorInk}>
              {text.slice(c, c + 1) || ' '}
            </Text>
            <Text color={t.ink}>{text.slice(c + 1)}</Text>
          </Text>
        );
      })}
    </Box>
  );
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
  const from = hexToRgb(t.accent);
  const to = hexToRgb(t.agent);
  const showMark = columns >= WORDMARK_COMPACT[0]!.length + 6;
  const width = WORDMARK_COMPACT[0]!.length;
  const v = version.startsWith('v') ? version : `v${version}`;
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={t.border} paddingX={1} marginTop={1} width={Math.min(columns, 78)}>
      {showMark &&
        WORDMARK_COMPACT.map((row, r) => (
          <Box key={r}>
            {gradientSegments(row, width, from, to).map((s, i) => (
              <Text key={i} color={s.color}>
                {s.text}
              </Text>
            ))}
          </Box>
        ))}
      <Box marginTop={showMark ? 1 : 0}>
        <Text color={t.accent}>{g.star} </Text>
        <Text color={t.ink} bold>
          AutoCode {v}
        </Text>
      </Box>
      <Box>
        <Text color={t.inkDim}>
          {'  '}{provider}/{model} · {basename(projectRoot) || projectRoot}
          {branch ? ` (${branch})` : ''}
        </Text>
      </Box>
      <Box>
        <Text color={t.inkDim}>{'  '}/help for commands · shift+tab cycles mode · ctrl+o expands results</Text>
      </Box>
    </Box>
  );
}

// ── helpers ───────────────────────────────────────────────────────────────

/**
 * Ink's <Static> is append-only and must never shrink (a shorter list resets
 * its cursor and later re-emits rows): an entry, once written, never changes
 * and nothing may commit ahead of an item that is still changing. So
 * everything from the first running tool onward stays in the live region, and
 * a trailing run of finished reads/lists waits there too, so it can commit as
 * one row ("Read 3 files") once something else lands after it. A turn always
 * ends with an item (turn_end, error, interrupt), so the run never lingers.
 */
function splitLive(items: TranscriptItem[]): { committed: TranscriptItem[]; live: TranscriptItem[] } {
  let cut = items.findIndex((it) => it.kind === 'tool' && it.tool?.status === 'running');
  if (cut < 0) cut = items.length;
  while (cut > 0 && isGroupable(items[cut - 1]!)) cut--;
  return { committed: items.slice(0, cut), live: items.slice(cut) };
}

/** The live region is a run of same-group reads/lists ending in the one still running. */
function liveReadGroup(live: TranscriptItem[]): ToolEntry[] | null {
  if (live.length < 2) return null;
  const tools: ToolEntry[] = [];
  for (const it of live) {
    if (it.kind !== 'tool' || !it.tool) return null;
    tools.push(it.tool);
  }
  const group = tools[0]!.group;
  if (group !== 'read' && group !== 'list') return null;
  if (!tools.every((x) => x.group === group && !x.bodyLines)) return null;
  if (tools.slice(0, -1).some((x) => x.status === 'running')) return null;
  if (tools[tools.length - 1]!.status !== 'running') return null;
  return tools;
}

function isGroupable(it: TranscriptItem): boolean {
  if (it.kind !== 'tool' || !it.tool) return false;
  const tool = it.tool;
  return (tool.group === 'read' || tool.group === 'list') && tool.status !== 'running' && !tool.bodyLines;
}

/** Collapse runs of ≥2 consecutive finished reads (or lists) into one row. */
function groupEntries(items: TranscriptItem[]): Entry[] {
  const out: Entry[] = [];
  let i = 0;
  while (i < items.length) {
    const it = items[i]!;
    const group = it.kind === 'tool' && it.tool ? it.tool.group : null;
    if (group === 'read' || group === 'list') {
      let j = i;
      const run: ToolEntry[] = [];
      while (j < items.length) {
        const c = items[j]!;
        if (c.kind === 'tool' && c.tool && c.tool.group === group && c.tool.status !== 'running' && !c.tool.bodyLines) {
          run.push(c.tool);
          j++;
        } else break;
      }
      if (run.length >= 2) {
        out.push({ type: 'toolgroup', key: it.id, tools: run });
        i = j;
        continue;
      }
    }
    out.push({ type: 'item', key: it.id, item: it });
    i++;
  }
  return out;
}
