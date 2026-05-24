// Ink Bridge app — the React tree that renders the full-screen Bridge
// TUI. Owns the input editor (text + cursor + history). Calls back into
// the controller (typically TerminalMode) for submit / mode-cycle / exit.

import React, { useEffect, useState, useCallback } from 'react';
import { Box, Text, useApp, useInput } from 'ink';
import { Rail } from './Rail.js';
import { Main } from './Main.js';
import { BR } from './theme.js';
import { useBridgeState, useTerminalSize } from './hooks.js';
import type { BridgeStore } from './store.js';
import type { SpinnerId } from './spinners.js';
import { bannerBlock, BANNER_GALLERY } from '../Banner.js';

// Bridge uses a single static welcome banner — gallery rotation was loud
// and stacked with the rail wordmark. ID 3 is the clean a-u-t-o-c-o-d-e
// inside a single-line box.
const WELCOME_BANNER = BANNER_GALLERY.find((b) => b.id === 3) ?? BANNER_GALLERY[0]!;

export interface InkAppHandle {
  // Imperative API the controller uses to drive the UI from outside React.
  setSpinnerId(id: SpinnerId): void;
  setExitCallback(cb: () => void): void;
}

export interface InkAppProps {
  store: BridgeStore;
  sessionId: string;
  projectRoot: string;
  modelProvider: string;
  modelName: string;
  version: string;

  // Callbacks into the host (TerminalMode/AgentHandler).
  onSubmit: (text: string) => void;
  onCycleMode: () => void;
  onInterrupt: () => void;
  onExit: () => void;
}

export function InkApp(props: InkAppProps): React.JSX.Element {
  const state = useBridgeState(props.store);
  const { columns, rows } = useTerminalSize();
  const [spinnerId, setSpinnerId] = useState<SpinnerId>('braille');
  const [showBanner, setShowBanner] = useState<boolean>(true);
  // Read /spinner config asynchronously after mount (so the file read
  // doesn't block first paint).
  useEffect(() => {
    void (async () => {
      try {
        const { ConfigStore } = await import('../../auth/ConfigStore.js');
        const cfg = new ConfigStore().load();
        const fromCfg = cfg.spinner?.default;
        if (fromCfg) setSpinnerId(fromCfg as SpinnerId);
      } catch {
        /* default braille */
      }
    })();
  }, []);

  // First-prompt-ends-the-banner: dismiss the welcome banner once the
  // user has submitted anything (turn > 0).
  useEffect(() => {
    if (state.turn > 0 && showBanner) setShowBanner(false);
  }, [state.turn, showBanner]);

  const app = useApp();

  const [input, setInput] = useState<string>('');
  const [cursor, setCursor] = useState<number>(0);
  const [history, setHistory] = useState<string[]>([]);
  const [histPos, setHistPos] = useState<number>(-1);

  const submit = useCallback(() => {
    const text = input;
    if (text.trim().length === 0) return;
    setHistory((h) => [...h, text]);
    setHistPos(-1);
    setInput('');
    setCursor(0);
    props.onSubmit(text);
  }, [input, props]);

  useInput((ch, key) => {
    if (key.ctrl && ch === 'c') {
      if (input.length > 0) {
        setInput('');
        setCursor(0);
        return;
      }
      props.onInterrupt();
      return;
    }
    if (key.tab && key.shift) {
      props.onCycleMode();
      return;
    }
    if (key.return) {
      submit();
      return;
    }
    if (key.escape) {
      setInput('');
      setCursor(0);
      return;
    }
    if (key.upArrow) {
      if (history.length === 0) return;
      const next = histPos < 0 ? history.length - 1 : Math.max(0, histPos - 1);
      setHistPos(next);
      const v = history[next] ?? '';
      setInput(v);
      setCursor(v.length);
      return;
    }
    if (key.downArrow) {
      if (history.length === 0 || histPos < 0) return;
      const next = histPos + 1;
      if (next >= history.length) {
        setHistPos(-1);
        setInput('');
        setCursor(0);
        return;
      }
      setHistPos(next);
      const v = history[next] ?? '';
      setInput(v);
      setCursor(v.length);
      return;
    }
    if (key.leftArrow) {
      setCursor((c) => Math.max(0, c - 1));
      return;
    }
    if (key.rightArrow) {
      setCursor((c) => Math.min(input.length, c + 1));
      return;
    }
    if (key.backspace || key.delete) {
      if (cursor === 0) return;
      setInput((s) => s.slice(0, cursor - 1) + s.slice(cursor));
      setCursor((c) => Math.max(0, c - 1));
      return;
    }
    if (ch && ch.length > 0 && !key.meta && !key.ctrl) {
      setInput((s) => s.slice(0, cursor) + ch + s.slice(cursor));
      setCursor((c) => c + ch.length);
    }
  });

  // Expose useApp's exit so the host can call ink.unmount() when done.
  useEffect(() => {
    return () => app.exit();
  }, [app]);

  // Hide the rail on narrow terminals — Bridge's rail is 32 columns; below
  // ~100 cols total the main column gets squished. Fall back to single
  // column. Below 60 cols, even the main padding is uncomfortable — keep
  // it readable.
  const showRail = columns >= 100;

  return (
    <Box flexDirection="column" width={columns} height={rows}>
      {showBanner && (
        <Box flexDirection="column" paddingX={2}>
          {bannerBlock(WELCOME_BANNER).map((line, i) => (
            <Text key={i} color={BR.teal}>{line}</Text>
          ))}
        </Box>
      )}
      <Box flexDirection="row" flexGrow={1}>
        {showRail && (
          <Rail
            state={state}
            sessionId={props.sessionId}
            projectRoot={props.projectRoot}
            modelProvider={props.modelProvider}
            modelName={props.modelName}
            version={props.version}
          />
        )}
        <Main state={state} input={input} cursor={cursor} spinnerId={spinnerId} />
      </Box>
    </Box>
  );
}

// One-stop mount helper. Returns the Ink render instance — call
// `instance.unmount()` to exit cleanly. Manages alt-screen takeover
// (Bridge owns the full window for its lifetime, exits cleanly back to
// the user's shell with prior scrollback intact).
export async function mountInkApp(props: InkAppProps): Promise<{ unmount: () => void; waitUntilExit: () => Promise<void> }> {
  const { render } = await import('ink');
  // Enter alt-screen: save the cursor (DECSC), switch to alternate
  // screen buffer (1049h), move home, clear. On exit we restore.
  process.stdout.write('\x1b[?1049h\x1b[H\x1b[2J');
  let exited = false;
  const restore = (): void => {
    if (exited) return;
    exited = true;
    try {
      process.stdout.write('\x1b[?1049l');
    } catch {
      /* shell already closed */
    }
  };
  const inst = render(<InkApp {...props} />, {
    stdout: process.stdout,
    stdin: process.stdin,
    exitOnCtrlC: false,
    patchConsole: false,
  });
  // Belt-and-suspenders: if the process exits abruptly (uncaught error,
  // SIGTERM), still restore the main screen buffer so the user's
  // terminal doesn't get stuck in alt-screen mode.
  process.once('exit', restore);
  return {
    unmount: () => {
      try {
        inst.unmount();
      } finally {
        restore();
      }
    },
    waitUntilExit: () => inst.waitUntilExit().finally(restore),
  };
}
