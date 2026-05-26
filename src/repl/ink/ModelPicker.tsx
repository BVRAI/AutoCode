// Interactive model picker overlay — appears between the transcript region
// and the footer when the user runs `/model` with no args. Arrow keys
// navigate; Enter selects; Esc cancels. Reads from KNOWN_MODELS so adding
// a new model is a one-file edit in src/llm/models.ts.

import React, { useState, useMemo, useEffect } from 'react';
import { Box, Text, useInput } from 'ink';
import { BR } from './theme.js';
import { KNOWN_MODELS, type ModelInfo } from '../../llm/models.js';

export interface ModelPickerProps {
  // Pre-select the row matching this (used to highlight the active model).
  currentProvider: string;
  currentModel: string;
  onPick: (m: ModelInfo) => void;
  onCancel: () => void;
}

export function ModelPicker({ currentProvider, currentModel, onPick, onCancel }: ModelPickerProps): React.JSX.Element {
  // Build a flat ordered list with provider headers as virtual rows that
  // can't be selected; only model rows are selectable.
  type Row = { kind: 'header'; provider: string } | { kind: 'model'; model: ModelInfo };
  const rows: Row[] = useMemo(() => {
    const out: Row[] = [];
    let lastProvider = '';
    for (const m of KNOWN_MODELS) {
      if (m.provider !== lastProvider) {
        out.push({ kind: 'header', provider: m.provider });
        lastProvider = m.provider;
      }
      out.push({ kind: 'model', model: m });
    }
    return out;
  }, []);

  // Pre-select the active model if it matches one in the catalog.
  const initialIdx = useMemo(() => {
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i]!;
      if (r.kind === 'model' && r.model.provider === currentProvider && currentModel.startsWith(r.model.model)) {
        return i;
      }
    }
    // Default to the first selectable (model) row.
    for (let i = 0; i < rows.length; i++) if (rows[i]!.kind === 'model') return i;
    return 0;
  }, [rows, currentProvider, currentModel]);

  const [selectedIdx, setSelectedIdx] = useState<number>(initialIdx);

  // Step past header rows on up/down so the highlight only ever sits on
  // a model row.
  const stepTo = (start: number, direction: 1 | -1): number => {
    let i = start;
    for (let n = 0; n < rows.length; n++) {
      i = (i + direction + rows.length) % rows.length;
      if (rows[i]!.kind === 'model') return i;
    }
    return start;
  };

  useEffect(() => {
    if (rows[selectedIdx]?.kind !== 'model') {
      setSelectedIdx(stepTo(selectedIdx, 1));
    }
  }, []); // mount only

  useInput((_input, key) => {
    if (key.escape) {
      onCancel();
      return;
    }
    if (key.return) {
      const row = rows[selectedIdx];
      if (row && row.kind === 'model') onPick(row.model);
      return;
    }
    if (key.upArrow) {
      setSelectedIdx((i) => stepTo(i, -1));
      return;
    }
    if (key.downArrow) {
      setSelectedIdx((i) => stepTo(i, 1));
      return;
    }
  });

  return (
    <Box
      flexDirection="column"
      borderStyle="single"
      borderColor={BR.teal}
      paddingX={1}
      paddingY={0}
      marginX={2}
    >
      <Box>
        <Text color={BR.teal} bold>Select a model</Text>
        <Text color={BR.inkFaint}>  ↑↓ pick · enter confirm · esc cancel</Text>
      </Box>
      <Box flexDirection="column" marginTop={1}>
        {rows.map((r, i) => {
          if (r.kind === 'header') {
            return (
              <Box key={`h-${r.provider}`} marginTop={i === 0 ? 0 : 1}>
                <Text color={BR.inkFaint}>{r.provider.toUpperCase()}</Text>
              </Box>
            );
          }
          const selected = i === selectedIdx;
          const isCurrent =
            r.model.provider === currentProvider && currentModel.startsWith(r.model.model);
          const marker = selected ? '▸' : ' ';
          const labelColor = selected ? BR.teal : isCurrent ? BR.add : BR.ink;
          return (
            <Box key={`m-${r.model.provider}-${r.model.model}`}>
              <Text color={selected ? BR.teal : BR.inkFaint}>{marker} </Text>
              <Box width={32}>
                <Text color={labelColor} bold={selected}>
                  {r.model.label}
                </Text>
                {isCurrent && <Text color={BR.add}>  ← current</Text>}
              </Box>
              <Text color={BR.inkDim}>
                ${r.model.inputPerM}/M in · ${r.model.outputPerM}/M out
              </Text>
              {r.model.notes && (
                <Text color={BR.inkFaint}>  · {r.model.notes}</Text>
              )}
            </Box>
          );
        })}
      </Box>
    </Box>
  );
}
