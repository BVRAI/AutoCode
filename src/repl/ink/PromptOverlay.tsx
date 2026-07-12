// Interactive prompt overlay — renders the BridgePrompter's pending request
// (confirm / approve / choose / ask) between the transcript and the input
// row, in the same visual language as the model picker (single border,
// ▸ marker, faint hint line). Amber border: the agent is waiting on YOU.
//
// This is the component that makes default-mode review real in the Bridge —
// before it existed, an AutoAcceptPrompter silently approved everything.

import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { BR } from './theme.js';
import type { PromptRequest } from './store.js';

const APPROVE_ROWS: Array<{ label: string; decision: 'accept' | 'decline' | 'revise' }> = [
  { label: 'Accept', decision: 'accept' },
  { label: 'Decline', decision: 'decline' },
  { label: 'Revise — give the agent more guidance', decision: 'revise' },
];

export function PromptOverlay({ request }: { request: PromptRequest }): React.JSX.Element {
  switch (request.type) {
    case 'confirm':
      return <ConfirmPrompt message={request.message} resolve={request.resolve} />;
    case 'approve':
      return <ApprovePrompt label={request.label} resolve={request.resolve} />;
    case 'choose':
      return (
        <ChoosePrompt
          question={request.question}
          options={request.options}
          multiSelect={request.multiSelect}
          resolve={request.resolve}
        />
      );
    case 'ask':
      return <AskPrompt message={request.message} resolve={request.resolve} />;
  }
}

function Frame({ title, hint, children }: { title: string; hint: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <Box flexDirection="column" borderStyle="single" borderColor={BR.amber} paddingX={1} marginX={2}>
      <Box>
        <Text color={BR.amber} bold>{title}</Text>
        <Text color={BR.inkFaint}>{`  ${hint}`}</Text>
      </Box>
      <Box flexDirection="column" marginTop={1}>{children}</Box>
    </Box>
  );
}

function OptionRow({ text, selected, checked }: { text: string; selected: boolean; checked?: boolean }): React.JSX.Element {
  const marker = selected ? '▸' : ' ';
  const check = checked === undefined ? '' : checked ? '[x] ' : '[ ] ';
  return (
    <Box>
      <Text color={selected ? BR.teal : BR.inkFaint}>{marker} </Text>
      <Text color={selected ? BR.teal : BR.ink} bold={selected}>{check}{text}</Text>
    </Box>
  );
}

function ConfirmPrompt({ message, resolve }: { message: string; resolve: (yes: boolean) => void }): React.JSX.Element {
  const [idx, setIdx] = useState(0); // 0 = Yes, 1 = No
  useInput((ch, key) => {
    if (key.escape) { resolve(false); return; }
    if (key.return) { resolve(idx === 0); return; }
    if (ch === 'y' || ch === 'Y') { resolve(true); return; }
    if (ch === 'n' || ch === 'N') { resolve(false); return; }
    if (key.upArrow || key.downArrow || key.leftArrow || key.rightArrow || key.tab) {
      setIdx((i) => (i === 0 ? 1 : 0));
    }
  });
  return (
    <Frame title="Confirm" hint="↑↓ pick · enter confirm · y/n shortcut · esc = no">
      <Text color={BR.ink} wrap="wrap">{message}</Text>
      <Box marginTop={1} flexDirection="column">
        <OptionRow text="Yes" selected={idx === 0} />
        <OptionRow text="No" selected={idx === 1} />
      </Box>
    </Frame>
  );
}

function ApprovePrompt({
  label,
  resolve,
}: {
  label: string;
  resolve: (verdict: { decision: 'accept' | 'decline' | 'revise'; guidance?: string }) => void;
}): React.JSX.Element {
  const [idx, setIdx] = useState(0);
  const [guidanceMode, setGuidanceMode] = useState(false);
  const [guidance, setGuidance] = useState('');

  useInput((ch, key) => {
    if (guidanceMode) {
      if (key.return) { resolve({ decision: 'revise', guidance: guidance.trim() }); return; }
      if (key.escape) { setGuidanceMode(false); setGuidance(''); return; }
      if (key.backspace || key.delete) { setGuidance((s) => s.slice(0, -1)); return; }
      if (ch && ch.length > 0 && !key.ctrl && !key.meta) setGuidance((s) => s + ch);
      return;
    }
    if (key.escape) { resolve({ decision: 'decline' }); return; }
    if (key.return) {
      const row = APPROVE_ROWS[idx]!;
      if (row.decision === 'revise') { setGuidanceMode(true); return; }
      resolve({ decision: row.decision });
      return;
    }
    if (key.upArrow) { setIdx((i) => (i - 1 + APPROVE_ROWS.length) % APPROVE_ROWS.length); return; }
    if (key.downArrow) { setIdx((i) => (i + 1) % APPROVE_ROWS.length); return; }
    if (ch === 'a' || ch === 'A' || ch === 'y' || ch === 'Y') { resolve({ decision: 'accept' }); return; }
    if (ch === 'd' || ch === 'D' || ch === 'n' || ch === 'N') { resolve({ decision: 'decline' }); return; }
    if (ch === 'r' || ch === 'R') { setGuidanceMode(true); return; }
  });

  if (guidanceMode) {
    return (
      <Frame title="Revise" hint="type guidance · enter send · esc back">
        <Text color={BR.ink} wrap="wrap">{label}</Text>
        <Box marginTop={1}>
          <Text color={BR.teal}>{'> '}</Text>
          <Text color={BR.ink}>{guidance}</Text>
          <Text color={BR.teal}>▎</Text>
        </Box>
      </Frame>
    );
  }
  return (
    <Frame title="Approval required" hint="↑↓ pick · enter confirm · a/d/r shortcut · esc = decline">
      <Text color={BR.ink} wrap="wrap">{label}</Text>
      <Box marginTop={1} flexDirection="column">
        {APPROVE_ROWS.map((r, i) => (
          <OptionRow key={r.decision} text={r.label} selected={i === idx} />
        ))}
      </Box>
    </Frame>
  );
}

function ChoosePrompt({
  question,
  options,
  multiSelect,
  resolve,
}: {
  question: string;
  options: string[];
  multiSelect: boolean;
  resolve: (picked: number[]) => void;
}): React.JSX.Element {
  const [idx, setIdx] = useState(0);
  const [checked, setChecked] = useState<Set<number>>(new Set());

  useInput((ch, key) => {
    if (key.escape) { resolve([]); return; }
    if (key.return) {
      if (multiSelect) resolve(checked.size > 0 ? [...checked].sort((a, b) => a - b) : [idx]);
      else resolve([idx]);
      return;
    }
    if (key.upArrow) { setIdx((i) => (i - 1 + options.length) % options.length); return; }
    if (key.downArrow) { setIdx((i) => (i + 1) % options.length); return; }
    if (multiSelect && ch === ' ') {
      setChecked((s) => {
        const next = new Set(s);
        if (next.has(idx)) next.delete(idx);
        else next.add(idx);
        return next;
      });
    }
  });

  const hint = multiSelect
    ? '↑↓ pick · space toggle · enter confirm · esc cancel'
    : '↑↓ pick · enter confirm · esc cancel';
  return (
    <Frame title="Question" hint={hint}>
      <Text color={BR.ink} wrap="wrap">{question}</Text>
      <Box marginTop={1} flexDirection="column">
        {options.map((o, i) => (
          <OptionRow
            key={`opt-${i}`}
            text={o}
            selected={i === idx}
            checked={multiSelect ? checked.has(i) : undefined}
          />
        ))}
      </Box>
    </Frame>
  );
}

function AskPrompt({ message, resolve }: { message: string; resolve: (answer: string) => void }): React.JSX.Element {
  const [value, setValue] = useState('');
  useInput((ch, key) => {
    if (key.return) { resolve(value.trim()); return; }
    if (key.escape) { resolve(''); return; }
    if (key.backspace || key.delete) { setValue((s) => s.slice(0, -1)); return; }
    if (ch && ch.length > 0 && !key.ctrl && !key.meta) setValue((s) => s + ch);
  });
  return (
    <Frame title="Input needed" hint="type · enter send · esc cancel">
      <Text color={BR.ink} wrap="wrap">{message}</Text>
      <Box marginTop={1}>
        <Text color={BR.teal}>{'> '}</Text>
        <Text color={BR.ink}>{value}</Text>
        <Text color={BR.teal}>▎</Text>
      </Box>
    </Frame>
  );
}
