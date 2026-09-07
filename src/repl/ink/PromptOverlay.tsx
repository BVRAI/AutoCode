// Interactive prompt overlay — renders the BridgePrompter's pending request
// (confirm / approve / choose / ask) between the transcript and the composer.
// The approval dialog follows Claude Code's permission prompt: what is about
// to run (the command, or the edit as a diff), then
//   1. Yes
//   2. Yes, and don't ask again for <scope>
//   3. No, and tell AutoCode what to do differently (esc)
// This is the component that makes default-mode review real in the Bridge.

import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { useTheme, type Theme } from './theme.js';
import type { PromptRequest } from './store.js';
import type { ApproveDetail, ApproveVerdict } from '../Prompter.js';
import { glyphs } from './glyphs.js';

export function PromptOverlay({ request }: { request: PromptRequest }): React.JSX.Element {
  switch (request.type) {
    case 'confirm':
      return <ConfirmPrompt message={request.message} resolve={request.resolve} />;
    case 'approve':
      return <ApprovePrompt label={request.label} detail={request.detail} resolve={request.resolve} />;
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

function Frame({ t, title, hint, children }: { t: Theme; title: string; hint: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={t.permission} paddingX={1} marginTop={1}>
      <Box>
        <Text color={t.ink} bold>
          {title}
        </Text>
        {hint.length > 0 && <Text color={t.inkDim}>{`  ${hint}`}</Text>}
      </Box>
      <Box flexDirection="column" marginTop={1}>
        {children}
      </Box>
    </Box>
  );
}

function OptionRow({ t, index, text, selected, checked }: { t: Theme; index: number; text: string; selected: boolean; checked?: boolean }): React.JSX.Element {
  const marker = selected ? glyphs().pointer : ' ';
  const check = checked === undefined ? '' : checked ? '[x] ' : '[ ] ';
  return (
    <Box>
      <Text color={selected ? t.accent : t.inkDim}>{marker} </Text>
      <Text color={selected ? t.accent : t.ink} bold={selected}>
        {index}. {check}
        {text}
      </Text>
    </Box>
  );
}

function ConfirmPrompt({ message, resolve }: { message: string; resolve: (yes: boolean) => void }): React.JSX.Element {
  const t = useTheme();
  const [idx, setIdx] = useState(0); // 0 = Yes, 1 = No
  useInput((ch, key) => {
    if (key.escape) { resolve(false); return; }
    if (key.return) { resolve(idx === 0); return; }
    if (ch === 'y' || ch === 'Y' || ch === '1') { resolve(true); return; }
    if (ch === 'n' || ch === 'N' || ch === '2') { resolve(false); return; }
    if (key.upArrow || key.downArrow || key.leftArrow || key.rightArrow || key.tab) {
      setIdx((i) => (i === 0 ? 1 : 0));
    }
  });
  return (
    <Frame t={t} title="Confirm" hint="">
      <Text color={t.ink} wrap="wrap">
        {message}
      </Text>
      <Box marginTop={1} flexDirection="column">
        <OptionRow t={t} index={1} text="Yes" selected={idx === 0} />
        <OptionRow t={t} index={2} text="No (esc)" selected={idx === 1} />
      </Box>
    </Frame>
  );
}

function titleFor(detail: ApproveDetail | undefined, label: string): string {
  switch (detail?.tool) {
    case 'run_shell':
      return 'Bash command';
    case 'edit_file':
      return 'Edit file';
    case 'write_file':
      return 'Write file';
    case 'delete_path':
      return 'Delete';
    case 'create_directory':
      return 'Create directory';
    default:
      return detail?.tool ? `Run ${detail.tool}` : label;
  }
}

function ApprovePrompt({
  label,
  detail,
  resolve,
}: {
  label: string;
  detail?: ApproveDetail;
  resolve: (verdict: ApproveVerdict) => void;
}): React.JSX.Element {
  const t = useTheme();
  const [idx, setIdx] = useState(0);
  const [guidanceMode, setGuidanceMode] = useState(false);
  const [guidance, setGuidance] = useState('');

  const rows: Array<{ text: string; decision: ApproveVerdict['decision'] }> = [
    { text: 'Yes', decision: 'accept' },
    { text: `Yes, and don't ask again for ${detail?.scope ?? 'this kind of action this session'}`, decision: 'accept_always' },
    { text: 'No, and tell AutoCode what to do differently (esc)', decision: 'revise' },
  ];

  useInput((ch, key) => {
    if (guidanceMode) {
      // A text chunk can arrive with its Enter glued on (fast typing, pastes,
      // ConPTY coalescing): take the text, then treat the newline as Enter.
      const { text, enter } = splitEnter(ch, key.return);
      if (enter) {
        const full = (guidance + text).trim();
        resolve(full.length > 0 ? { decision: 'revise', guidance: full } : { decision: 'decline' });
        return;
      }
      if (key.escape) { resolve({ decision: 'decline' }); return; }
      if (key.backspace || key.delete) { setGuidance((s) => s.slice(0, -1)); return; }
      if (text.length > 0 && !key.ctrl && !key.meta) setGuidance((s) => s + text);
      return;
    }
    if (key.escape) { resolve({ decision: 'decline' }); return; }
    if (key.return) {
      const row = rows[idx]!;
      if (row.decision === 'revise') { setGuidanceMode(true); return; }
      resolve({ decision: row.decision });
      return;
    }
    if (key.upArrow) { setIdx((i) => (i - 1 + rows.length) % rows.length); return; }
    if (key.downArrow) { setIdx((i) => (i + 1) % rows.length); return; }
    if (ch === '1' || ch === 'y' || ch === 'Y') { resolve({ decision: 'accept' }); return; }
    if (ch === '2' || ch === 'a' || ch === 'A') { resolve({ decision: 'accept_always' }); return; }
    if (ch === '3' || ch === 'n' || ch === 'N') { setGuidanceMode(true); return; }
  });

  const rawPreview = (detail?.preview ?? '').split(/\r?\n/);
  const preview = rawPreview.length === 1 && rawPreview[0]!.trim() === '' ? [] : rawPreview;
  const shown = preview.slice(0, 14);
  const hidden = preview.length - shown.length;
  const title = titleFor(detail, label);

  if (guidanceMode) {
    return (
      <Frame t={t} title={title} hint="tell AutoCode what to do differently · enter send · esc = no">
        <Box>
          <Text color={t.accent}>{'> '}</Text>
          <Text color={t.ink}>{guidance}</Text>
          <Text backgroundColor={t.accent} color={t.cursorInk}>
            {' '}
          </Text>
        </Box>
      </Frame>
    );
  }
  return (
    <Frame t={t} title={title} hint="">
      {shown.length > 0 && (
        <Box flexDirection="column" marginBottom={1}>
          {shown.map((line, i) => (
            <Text key={i} color={lineColor(t, line)}>
              {line}
            </Text>
          ))}
          {hidden > 0 && <Text color={t.inkDim}>… +{hidden} lines</Text>}
        </Box>
      )}
      <Text color={t.ink}>Do you want to proceed?</Text>
      <Box marginTop={1} flexDirection="column">
        {rows.map((r, i) => (
          <OptionRow key={r.decision} t={t} index={i + 1} text={r.text} selected={i === idx} />
        ))}
      </Box>
    </Frame>
  );
}

function lineColor(t: Theme, line: string): string {
  if (line.startsWith('+ ')) return t.add;
  if (line.startsWith('- ')) return t.del;
  if (line.startsWith('@@')) return t.inkDim;
  if (line.startsWith('$ ')) return t.ink;
  return t.inkDim;
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
  const t = useTheme();
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
    const n = Number.parseInt(ch, 10);
    if (!multiSelect && Number.isInteger(n) && n >= 1 && n <= options.length) { resolve([n - 1]); return; }
    if (multiSelect && ch === ' ') {
      setChecked((s) => {
        const next = new Set(s);
        if (next.has(idx)) next.delete(idx);
        else next.add(idx);
        return next;
      });
    }
  });

  const hint = multiSelect ? 'space toggles · enter confirm · esc cancel' : 'enter confirm · esc cancel';
  return (
    <Frame t={t} title="Question" hint={hint}>
      <Text color={t.ink} wrap="wrap">
        {question}
      </Text>
      <Box marginTop={1} flexDirection="column">
        {options.map((o, i) => (
          <OptionRow
            key={`opt-${i}`}
            t={t}
            index={i + 1}
            text={o}
            selected={i === idx}
            checked={multiSelect ? checked.has(i) : undefined}
          />
        ))}
      </Box>
    </Frame>
  );
}

/**
 * Split a chunk of typed input into its text and whether it ends with Enter.
 * Ink's parser keeps `\r`/`\n` inside a multi-character chunk, so a fast
 * typist, a paste, or ConPTY coalescing can deliver "text\r" as one event.
 */
export function splitEnter(ch: string, isReturn: boolean): { text: string; enter: boolean } {
  if (isReturn) return { text: '', enter: true };
  const idx = ch.search(/[\r\n]/);
  if (idx < 0) return { text: ch, enter: false };
  return { text: ch.slice(0, idx), enter: true };
}

function AskPrompt({ message, resolve }: { message: string; resolve: (answer: string) => void }): React.JSX.Element {
  const t = useTheme();
  const [value, setValue] = useState('');
  useInput((ch, key) => {
    const { text, enter } = splitEnter(ch, key.return);
    if (enter) { resolve((value + text).trim()); return; }
    if (key.escape) { resolve(''); return; }
    if (key.backspace || key.delete) { setValue((s) => s.slice(0, -1)); return; }
    if (text.length > 0 && !key.ctrl && !key.meta) setValue((s) => s + text);
  });
  return (
    <Frame t={t} title="Input needed" hint="enter send · esc cancel">
      <Text color={t.ink} wrap="wrap">
        {message}
      </Text>
      <Box marginTop={1}>
        <Text color={t.accent}>{'> '}</Text>
        <Text color={t.ink}>{value}</Text>
        <Text backgroundColor={t.accent} color={t.cursorInk}>
          {' '}
        </Text>
      </Box>
    </Frame>
  );
}
