// KeyManager — the `/keys` overlay. An up/down menu (same pattern as the
// model picker) that shows every BYOK provider, whether a key is set, where it
// lives, its last 4 chars, and when it was added — and lets the user add,
// replace, or remove a key without echoing the secret on the command line.
//
// Modes:
//   list    — the provider rows; ↑↓ to move, enter to act, esc to close.
//   actions — for a stored key: [Replace] / [Remove].
//   input   — paste/type a key for the selected provider.
//   env     — note shown when the active key comes from an env var (can't be
//             managed here — the user unsets it in their shell).

import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { useTheme } from './theme.js';
import { keyStatuses, type KeyStatus } from '../../auth/keyStatus.js';

export interface KeyManagerProps {
  onSave: (provider: string, apiKey: string) => Promise<void>;
  onRemove: (provider: string) => Promise<void>;
  onClose: () => void;
}

type Mode = 'list' | 'actions' | 'input' | 'env';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function fmtDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${MONTHS[d.getMonth()]} ${d.getDate()}`;
}

function sourceLabel(s: KeyStatus): string {
  if (s.source === 'env') return `env: ${s.envKey}`;
  if (s.source === 'keyring') return 'keyring';
  if (s.source === 'config') return 'config file';
  return '';
}

export function KeyManager({ onSave, onRemove, onClose }: KeyManagerProps): React.JSX.Element {
  const t = useTheme();
  const [rows, setRows] = useState<KeyStatus[]>(() => keyStatuses());
  const [idx, setIdx] = useState<number>(0);
  const [mode, setMode] = useState<Mode>('list');
  const [actionIdx, setActionIdx] = useState<number>(0); // 0 = Replace, 1 = Remove
  const [draft, setDraft] = useState<string>('');
  const [busy, setBusy] = useState<boolean>(false);

  const current = rows[idx]!;

  const refresh = (): void => setRows(keyStatuses());

  useInput((ch, key) => {
    if (busy) return;

    if (mode === 'list') {
      if (key.escape) return onClose();
      if (key.upArrow) return setIdx((i) => (i - 1 + rows.length) % rows.length);
      if (key.downArrow) return setIdx((i) => (i + 1) % rows.length);
      if (key.return) {
        if (!current.set) {
          setDraft('');
          setMode('input');
        } else if (current.source === 'env') {
          setMode('env');
        } else {
          setActionIdx(0);
          setMode('actions');
        }
      }
      return;
    }

    if (mode === 'actions') {
      if (key.escape) return setMode('list');
      if (key.upArrow || key.downArrow) return setActionIdx((i) => (i + 1) % 2);
      if (key.return) {
        if (actionIdx === 0) {
          setDraft('');
          setMode('input');
        } else {
          setBusy(true);
          void onRemove(current.id).finally(() => {
            refresh();
            setBusy(false);
            setMode('list');
          });
        }
      }
      return;
    }

    if (mode === 'env') {
      if (key.escape || key.return) return setMode('list');
      return;
    }

    // input mode
    if (key.escape) {
      setDraft('');
      setMode(current.set ? 'actions' : 'list');
      return;
    }
    if (key.return) {
      const v = draft.trim();
      if (v.length < 8) return; // too short — ignore, keep waiting
      setBusy(true);
      void onSave(current.id, v).finally(() => {
        setDraft('');
        refresh();
        setBusy(false);
        setMode('list');
      });
      return;
    }
    if (key.backspace || key.delete) {
      setDraft((s) => s.slice(0, -1));
      return;
    }
    if (ch && ch.length > 0 && !key.meta && !key.ctrl) {
      setDraft((s) => s + ch);
    }
  });

  return (
    <Box flexDirection="column" borderStyle="single" borderColor={t.accent} paddingX={1} marginX={2}>
      <Box>
        <Text color={t.accent} bold>API keys — your own (BYOK)</Text>
        <Text color={t.inkFaint}>   for the BVRAI proxy subscription, use /login</Text>
      </Box>

      {mode === 'input' ? (
        <Box flexDirection="column" marginTop={1}>
          <Text color={t.ink}>Paste your {current.label} API key{busy ? ' …saving' : ''}:</Text>
          <Box marginTop={0}>
            <Text color={t.accent}>{'> '}</Text>
            <Text color={t.ink}>{draft}</Text>
            <Text backgroundColor={t.accent} color={t.cursorInk}> </Text>
          </Box>
          <Text color={t.inkFaint}>{current.signupUrl}  ·  enter save · esc back</Text>
        </Box>
      ) : mode === 'env' ? (
        <Box flexDirection="column" marginTop={1}>
          <Text color={t.warn}>{current.label} is set via the {current.envKey} environment variable.</Text>
          <Text color={t.inkDim}>Env vars take precedence and can't be managed here — unset it in your shell to manage a saved key.</Text>
          <Text color={t.inkFaint}>esc back</Text>
        </Box>
      ) : (
        <>
          <Box flexDirection="column" marginTop={1}>
            {rows.map((r, i) => {
              const selected = i === idx;
              return (
                <Box key={r.id}>
                  <Text color={selected ? t.accent : t.inkFaint}>{selected ? '▸' : ' '} </Text>
                  <Box width={16}>
                    <Text color={selected ? t.accent : t.ink} bold={selected}>{r.label}</Text>
                  </Box>
                  {r.set ? (
                    <Text color={t.add}>
                      ✓ {sourceLabel(r)} · …{r.last4}
                      {r.addedAt ? <Text color={t.inkDim}> · added {fmtDate(r.addedAt)}</Text> : null}
                    </Text>
                  ) : (
                    <Text color={t.inkDim}>— not set</Text>
                  )}
                </Box>
              );
            })}
          </Box>

          {mode === 'actions' ? (
            <Box marginTop={1}>
              <Text color={t.inkFaint}>{current.label}:  </Text>
              <Text color={actionIdx === 0 ? t.accent : t.inkDim} bold={actionIdx === 0}>{actionIdx === 0 ? '▸ ' : '  '}Replace</Text>
              <Text color={t.inkFaint}>   </Text>
              <Text color={actionIdx === 1 ? t.rose : t.inkDim} bold={actionIdx === 1}>{actionIdx === 1 ? '▸ ' : '  '}Remove</Text>
              <Text color={t.inkFaint}>   ↑↓ pick · enter · esc back</Text>
            </Box>
          ) : (
            <Box marginTop={1}>
              <Text color={t.inkFaint}>↑↓ select · enter manage · esc close</Text>
            </Box>
          )}
        </>
      )}
    </Box>
  );
}
