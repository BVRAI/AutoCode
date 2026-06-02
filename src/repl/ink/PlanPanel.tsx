// PlanPanel — the sticky plan / checklist, docked in the inline live region.
// Driven by the todo_write list mirrored into state.plan. Defaults to a single
// collapsed line (low + stable height); ^P expands it. Glyphs fall back to
// ASCII on plain terminals. Per the Claude Design spec (tui/plan.jsx).

import React from 'react';
import { Box, Text } from 'ink';
import type { PlanItem } from './store.js';
import { useTheme, type Theme } from './theme.js';
import { glyphs } from './glyphs.js';

function statusGlyph(t: Theme, status: PlanItem['status']): { g: string; c: string } {
  const gl = glyphs();
  switch (status) {
    case 'completed':
      return { g: gl.planDone, c: t.add };
    case 'in_progress':
      return { g: gl.planActive, c: t.accent };
    case 'interrupted':
      return { g: gl.planInterrupted, c: t.warn };
    default:
      return { g: gl.planPending, c: t.inkFaint };
  }
}

function bar(t: Theme, pct: number, cells: number): React.JSX.Element {
  const g = glyphs();
  const filled = Math.round(cells * Math.max(0, Math.min(1, pct)));
  return (
    <Text>
      <Text color={t.add}>{g.barFull.repeat(filled)}</Text>
      <Text color={t.ruleStrong}>{g.barEmpty.repeat(cells - filled)}</Text>
      <Text color={t.inkDim}> {Math.round(pct * 100)}%</Text>
    </Text>
  );
}

export function PlanPanel({ items, collapsed }: { items: PlanItem[]; collapsed: boolean }): React.JSX.Element | null {
  const t = useTheme();
  const g = glyphs();
  if (items.length === 0) return null;
  const done = items.filter((i) => i.status === 'completed').length;
  const total = items.length;
  const pct = total ? done / total : 0;
  const current = items.find((i) => i.status === 'in_progress');

  if (collapsed) {
    return (
      <Box marginTop={1}>
        <Text color={t.accent}>{g.planActive}</Text>
        <Text color={t.inkDim}> Plan </Text>
        <Text color={t.ink}>{done}/{total}</Text>
        <Text color={t.inkFaint}>{'  ·  '}</Text>
        <Text color={t.ink}>{current ? current.text : 'all steps complete'}</Text>
        <Box flexGrow={1} />
        <Text color={t.inkFaint}>^P</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" marginTop={1} borderStyle="single" borderColor={t.ruleStrong} paddingX={1}>
      <Box>
        <Text color={t.accent} bold>PLAN</Text>
        <Text color={t.inkDim}>  {done}/{total} done</Text>
        <Box flexGrow={1} />
        {bar(t, pct, 5)}
        <Text color={t.inkFaint}>  ·  ^P</Text>
      </Box>
      {items.map((it, i) => {
        const { g: gl, c } = statusGlyph(t, it.status);
        const active = it.status === 'in_progress';
        const textColor = it.status === 'completed' ? t.inkDim : active ? t.ink : it.status === 'interrupted' ? t.warn : t.inkDim;
        return (
          <Box key={i}>
            <Text color={c}>{gl} </Text>
            <Text color={textColor} bold={active} strikethrough={it.status === 'completed'}>
              {it.text}
            </Text>
          </Box>
        );
      })}
    </Box>
  );
}
