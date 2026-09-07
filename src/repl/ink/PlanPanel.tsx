// PlanPanel — the todo tray above the composer (Claude Code's Ctrl+T
// checklist). Driven by the todo_write list mirrored into state.plan. Shows a
// one-line summary by default; Ctrl+T expands up to five tasks. Glyphs fall
// back to ASCII on plain terminals.

import React from 'react';
import { Box, Text } from 'ink';
import type { PlanItem } from './store.js';
import { useTheme, type Theme } from './theme.js';
import { glyphs } from './glyphs.js';

const MAX_ROWS = 5;

function mark(t: Theme, status: PlanItem['status']): { g: string; c: string } {
  const gl = glyphs();
  switch (status) {
    case 'completed':
      return { g: gl.checked, c: t.inkDim };
    case 'in_progress':
      return { g: gl.unchecked, c: t.accent };
    case 'interrupted':
      return { g: gl.warn, c: t.warn };
    default:
      return { g: gl.unchecked, c: t.inkDim };
  }
}

export function PlanPanel({ items, collapsed }: { items: PlanItem[]; collapsed: boolean }): React.JSX.Element | null {
  const t = useTheme();
  if (items.length === 0) return null;
  const done = items.filter((i) => i.status === 'completed').length;
  const total = items.length;
  const current = items.find((i) => i.status === 'in_progress') ?? items.find((i) => i.status === 'pending');

  if (collapsed) {
    return (
      <Box marginTop={1}>
        <Text color={t.inkDim}>Todos {done}/{total}</Text>
        {current && <Text color={t.inkDim}>{'  ·  '}{current.text}</Text>}
        <Text color={t.inkDim}>{'  (ctrl+t to expand)'}</Text>
      </Box>
    );
  }

  // Show the active item and its neighbours, at most five rows.
  const activeIdx = Math.max(0, items.findIndex((i) => i.status === 'in_progress'));
  const start = Math.max(0, Math.min(activeIdx - 1, total - MAX_ROWS));
  const shown = items.slice(start, start + MAX_ROWS);
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text color={t.inkDim}>Todos {done}/{total}{'  (ctrl+t to collapse)'}</Text>
      {shown.map((it, i) => {
        const m = mark(t, it.status);
        const active = it.status === 'in_progress';
        return (
          <Box key={start + i}>
            <Text color={m.c}>  {m.g} </Text>
            <Text color={active ? t.ink : t.inkDim} bold={active} strikethrough={it.status === 'completed'}>
              {it.text}
            </Text>
          </Box>
        );
      })}
      {total > shown.length && (
        <Text color={t.inkDim}>  … {total - shown.length} more</Text>
      )}
    </Box>
  );
}
