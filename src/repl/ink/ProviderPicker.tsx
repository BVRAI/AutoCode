// Stage-1 picker overlay — appears when the user runs `/model` with no args.
// Lists the providers represented in the active catalog (bundled fallback or
// proxy overlay), with a model count next to each. Picking one transitions
// the bridge overlay to {kind:'model-models', provider:<picked>}, which
// surfaces ModelPicker.tsx for that provider's rows.
//
// Mirrors the visual language of ModelPicker (teal border, faint hint line,
// ▸ marker for highlighted row, mono provider label) so the two stages feel
// like one flow rather than two separate widgets.

import React, { useMemo, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { useTheme } from './theme.js';
import { getKnownModels, modelCatalogDetail } from '../../llm/models.js';

export interface ProviderPickerProps {
  // Highlight the row matching the currently-active provider.
  currentProvider: string;
  onPick: (provider: string) => void;
  onCancel: () => void;
}

interface ProviderRow {
  name: string;
  modelCount: number;
}

export function ProviderPicker({ currentProvider, onPick, onCancel }: ProviderPickerProps): React.JSX.Element {
  const t = useTheme();
  // Group the active catalog by provider so each row can show a count.
  // Order preserved from the model list (catalog declaration order).
  const rows = useMemo<ProviderRow[]>(() => {
    const counts = new Map<string, number>();
    const order: string[] = [];
    for (const m of getKnownModels()) {
      if (!counts.has(m.provider)) order.push(m.provider);
      counts.set(m.provider, (counts.get(m.provider) ?? 0) + 1);
    }
    return order.map((name) => ({ name, modelCount: counts.get(name) ?? 0 }));
  }, []);
  const detail = useMemo(() => modelCatalogDetail(), []);

  // Pre-select the row matching the current provider, else row 0.
  const initialIdx = useMemo(() => {
    const idx = rows.findIndex((r) => r.name.toLowerCase() === currentProvider.toLowerCase());
    return idx >= 0 ? idx : 0;
  }, [rows, currentProvider]);

  const [selectedIdx, setSelectedIdx] = useState<number>(initialIdx);

  useInput((_input, key) => {
    if (key.escape) {
      onCancel();
      return;
    }
    if (key.return) {
      const row = rows[selectedIdx];
      if (row) onPick(row.name);
      return;
    }
    if (key.upArrow) {
      setSelectedIdx((i) => (i - 1 + rows.length) % rows.length);
      return;
    }
    if (key.downArrow) {
      setSelectedIdx((i) => (i + 1) % rows.length);
      return;
    }
  });

  return (
    <Box
      flexDirection="column"
      borderStyle="single"
      borderColor={t.teal}
      paddingX={1}
      paddingY={0}
      marginX={2}
    >
      <Box>
        <Box flexShrink={0}>
          <Text color={t.teal} bold>Select a provider</Text>
        </Box>
        <Text color={t.inkFaint} wrap="truncate-end">
          {`  ${rows.length} providers · ↑↓ pick · enter confirm · esc cancel`}
        </Text>
      </Box>
      <Text color={t.inkFaint} wrap="truncate-end">{detail}</Text>
      <Box flexDirection="column" marginTop={1}>
        {rows.map((r, i) => {
          const selected = i === selectedIdx;
          const isCurrent = r.name.toLowerCase() === currentProvider.toLowerCase();
          const marker = selected ? '▸' : ' ';
          const labelColor = selected ? t.teal : isCurrent ? t.add : t.ink;
          return (
            <Box key={`p-${r.name}`}>
              <Text color={selected ? t.teal : t.inkFaint}>{marker} </Text>
              <Box width={20}>
                <Text color={labelColor} bold={selected}>
                  {r.name.toUpperCase()}
                </Text>
                {isCurrent && <Text color={t.add}>  ← current</Text>}
              </Box>
              <Text color={t.inkDim}>{r.modelCount} model{r.modelCount === 1 ? '' : 's'}</Text>
            </Box>
          );
        })}
      </Box>
    </Box>
  );
}
