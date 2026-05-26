// Bridge left rail — persistent cockpit panel. Translated from
// tui-bridge.jsx:58–258. ~32 columns wide on a terminal; we hide it
// entirely on terminals narrower than 100 cols.

import React from 'react';
import { Box, Text } from 'ink';
import { BR } from './theme.js';
import type { BridgeState, RailEditSummary, McpStatusEntry } from './store.js';
import { basename } from 'node:path';

const RAIL_WIDTH = 32;

export interface RailProps {
  state: BridgeState;
  sessionId: string;
  projectRoot: string;
  modelProvider: string;
  modelName: string;
  version: string;
}

export function Rail({ state, sessionId, projectRoot, modelProvider, modelName, version }: RailProps): React.JSX.Element {
  return (
    <Box
      width={RAIL_WIDTH}
      flexDirection="column"
      paddingX={1}
      paddingY={1}
      borderStyle="single"
      borderColor={BR.rule}
      borderTop={false}
      borderBottom={false}
      borderLeft={false}
    >
      <Wordmark />
      <Block label="SESSION">
        <Text color={BR.ink}>{shortSession(sessionId)}</Text>
        <Text color={BR.inkDim}>{sessionAge(sessionId)}</Text>
      </Block>
      <Block label="PROJECT">
        <Text color={BR.ink}>{truncate(basename(projectRoot), RAIL_WIDTH - 4)}</Text>
        <Text color={BR.inkDim}>
          <Text color={BR.teal}>master</Text>
        </Text>
      </Block>
      <Block label="MODEL">
        <Text color={BR.ink}>{modelProvider} / {truncate(modelName, RAIL_WIDTH - 4 - modelProvider.length - 3)}</Text>
      </Block>

      <ModeList active={state.mode} />
      <ContextMeter usage={state.usage} />
      <EditsList edits={state.editsThisTurn} turn={state.turn} />
      <McpBlock entries={state.mcpStatus} />

      <Box flexGrow={1} />
      <Text color={BR.inkFaint}>autocode {version}</Text>
      <Text color={BR.inkFaint}>shift+tab cycle · ^c stop</Text>
    </Box>
  );
}

function Wordmark(): React.JSX.Element {
  return (
    <Box marginBottom={1}>
      <Text color={BR.teal} bold>
        AUTOCODE
      </Text>
      <Text color={BR.inkFaint}>  acv1</Text>
    </Box>
  );
}

function Block({ label, children }: { label: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text color={BR.inkFaint}>{label}</Text>
      {children}
    </Box>
  );
}

function ModeList({ active }: { active: BridgeState['mode'] }): React.JSX.Element {
  // All four modes are always visible so users discover admin exists.
  // The Shift+Tab cycle stays at 3 coding modes (admin opt-in via
  // `/mode admin` or `--mode admin`), but the rail still lists admin
  // as a row — the rail's job is to show what's available, not what's
  // in the cycle.
  const modes: Array<{ id: BridgeState['mode']; label: string; hint: string; color: string }> = [
    { id: 'planning', label: 'planning', hint: 'read-only', color: BR.yellow },
    { id: 'default', label: 'default', hint: 'review', color: BR.teal },
    { id: 'autocode', label: 'autocode', hint: 'auto', color: BR.add },
    { id: 'admin', label: 'admin', hint: 'auto-ops', color: BR.violet },
  ];
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text color={BR.inkFaint}>MODE</Text>
      {modes.map((m) => {
        const on = m.id === active;
        return (
          <Box key={m.id}>
            <Text color={on ? m.color : BR.inkDim}>{on ? '▸ ' : '  '}</Text>
            <Text color={on ? m.color : BR.inkDim} bold={on}>
              {m.label.padEnd(9)}
            </Text>
            <Text color={BR.inkFaint}>{m.hint}</Text>
          </Box>
        );
      })}
    </Box>
  );
}

function ContextMeter({ usage }: { usage: BridgeState['usage'] }): React.JSX.Element {
  // 256k window is the cap shown by Bridge — match the design.
  const window = 256_000;
  const used = usage.inputTokens + usage.outputTokens;
  const pct = Math.max(0, Math.min(1, used / window));
  const cells = 18;
  const filled = Math.round(cells * pct);
  const cacheStr =
    usage.inputTokens > 0
      ? `${Math.round((usage.cacheReadTokens / Math.max(1, usage.inputTokens)) * 100)}%`
      : '0%';
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text color={BR.inkFaint}>CONTEXT</Text>
      <Box>
        <Text color={BR.teal}>{'▰'.repeat(filled)}</Text>
        <Text color={BR.ruleStrong}>{'▱'.repeat(cells - filled)}</Text>
        <Text color={BR.inkDim}>  {Math.round(pct * 100)}%</Text>
      </Box>
      <Box>
        <Text color={BR.inkDim}>in  </Text>
        <Text color={BR.ink}>{formatTokens(usage.inputTokens)}</Text>
      </Box>
      <Box>
        <Text color={BR.inkDim}>out </Text>
        <Text color={BR.ink}>{formatTokens(usage.outputTokens)}</Text>
      </Box>
      <Box>
        <Text color={BR.inkDim}>cache </Text>
        <Text color={BR.ink}>{cacheStr}</Text>
      </Box>
      <Box>
        <Text color={BR.inkDim}>cost </Text>
        <Text color={BR.teal}>${usage.costUsd.toFixed(2)}</Text>
      </Box>
    </Box>
  );
}

function EditsList({ edits, turn }: { edits: RailEditSummary[]; turn: number }): React.JSX.Element {
  if (edits.length === 0) {
    return (
      <Box flexDirection="column" marginBottom={1}>
        <Box>
          <Text color={BR.inkFaint}>EDITS · TURN {String(turn).padStart(2, '0')}</Text>
        </Box>
        <Text color={BR.inkFaint}>—</Text>
      </Box>
    );
  }
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box>
        <Text color={BR.inkFaint}>EDITS · TURN {String(turn).padStart(2, '0')}  </Text>
        <Text color={BR.inkDim}>{edits.length} file{edits.length === 1 ? '' : 's'}</Text>
      </Box>
      {edits.slice(-6).map((e) => (
        <Box key={e.file}>
          <Text color={e.isNew ? BR.teal : BR.inkDim}>{e.isNew ? '✦ ' : '· '}</Text>
          <Text color={BR.ink}>{truncate(basename(e.file), RAIL_WIDTH - 14)} </Text>
          <Text color={BR.add}>+{e.added}</Text>
          {e.deleted > 0 && <Text color={BR.del}> −{e.deleted}</Text>}
        </Box>
      ))}
    </Box>
  );
}

function McpBlock({ entries }: { entries: McpStatusEntry[] }): React.JSX.Element {
  if (entries.length === 0) return <></>;
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text color={BR.inkFaint}>MCP</Text>
      {entries.slice(0, 5).map((e) => {
        // Static dot color — pulsing here re-rendered the whole rail every
        // 450ms and produced visible flicker. Solid is enough status.
        const dot = e.connected ? BR.add : BR.rose;
        return (
          <Box key={e.name}>
            <Text color={dot}>● </Text>
            <Text color={BR.ink}>{truncate(e.name, RAIL_WIDTH - 10)} </Text>
            <Text color={BR.inkFaint}>{e.connected ? `${e.toolCount}` : 'err'}</Text>
          </Box>
        );
      })}
    </Box>
  );
}

// ── helpers ───────────────────────────────────────────────────────────

function truncate(s: string, n: number): string {
  if (n <= 1) return s.slice(0, n);
  return s.length <= n ? s : s.slice(0, n - 1) + '…';
}

function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 10_000) return (n / 1000).toFixed(1) + 'k';
  return Math.round(n / 1000) + 'k';
}

function shortSession(id: string): string {
  // sessionId shape: 20260524-022351-pgb2nk — show the date+time part.
  const dash = id.lastIndexOf('-');
  return dash > 0 ? id.slice(0, dash) : id;
}

function sessionAge(id: string): string {
  // sessionId shape: YYYYMMDD-HHMMSS-suffix. Parse the timestamp, show
  // suffix and rough age.
  const m = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})-(\w+)$/.exec(id);
  if (!m) return '';
  const [, y, mo, d, hh, mm, ss, suffix] = m as unknown as [string, string, string, string, string, string, string, string];
  const t = Date.UTC(+y, +mo - 1, +d, +hh, +mm, +ss);
  const mins = Math.max(0, Math.floor((Date.now() - t) / 60_000));
  const ageStr = mins < 60 ? `${mins}m` : `${Math.floor(mins / 60)}h${mins % 60}m`;
  return `${suffix} · ${ageStr}`;
}

export { RAIL_WIDTH };
