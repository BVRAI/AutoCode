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
import { ModelPicker } from './ModelPicker.js';
import { SlashMenu } from './SlashMenu.js';
import { filterCommands } from '../commands.js';

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
  // Fired when the user picks a new model from the picker overlay.
  onModelChange: (provider: string, model: string) => void;
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
  // Slash menu state — opens when input starts with `/` and the user
  // hasn't already finished typing a complete command name + space.
  const [slashIdx, setSlashIdx] = useState<number>(0);
  // Ctrl+C double-press protection. Pressing Ctrl+C on empty input
  // arms a 3-second window; a second Ctrl+C within that window exits.
  // Prevents accidental exits during long coding ops. Esc remains the
  // interrupt-the-agent keystroke.
  const [exitArmed, setExitArmed] = useState<boolean>(false);

  const submit = useCallback(() => {
    const text = input;
    if (text.trim().length === 0) return;
    setHistory((h) => [...h, text]);
    setHistPos(-1);
    setInput('');
    setCursor(0);
    setSlashIdx(0);
    props.onSubmit(text);
  }, [input, props]);

  // The menu opens when the user has typed `/` followed by a partial
  // command name (no space yet — once they hit space we assume they're
  // typing args and stop showing the popup). The query is everything
  // after the leading `/`.
  const slashQuery = input.startsWith('/') && !input.includes(' ') ? input.slice(1) : null;
  const slashOpen = slashQuery !== null;
  const slashMatches = slashOpen ? filterCommands(slashQuery!) : [];

  // Keep selection in range as the filter narrows.
  useEffect(() => {
    if (slashIdx >= slashMatches.length) setSlashIdx(Math.max(0, slashMatches.length - 1));
  }, [slashMatches.length, slashIdx]);

  useInput((ch, key) => {
    if (key.ctrl && ch === 'c') {
      // Typed text? Just clear it; never exit when there's input on the line.
      if (input.length > 0) {
        setInput('');
        setCursor(0);
        setExitArmed(false);
        return;
      }
      // Empty input — first Ctrl+C arms exit, second confirms.
      if (exitArmed) {
        props.onExit();
        return;
      }
      setExitArmed(true);
      // Disarm after 3s if no second press.
      setTimeout(() => setExitArmed(false), 3000);
      return;
    }
    if (key.tab && key.shift) {
      props.onCycleMode();
      return;
    }
    // Slash menu intercepts arrows / tab / enter while open so they
    // navigate the popup instead of doing their normal thing.
    if (slashOpen && slashMatches.length > 0) {
      if (key.upArrow) {
        setSlashIdx((i) => Math.max(0, i - 1));
        return;
      }
      if (key.downArrow) {
        setSlashIdx((i) => Math.min(slashMatches.length - 1, i + 1));
        return;
      }
      if (key.tab || key.return) {
        // Complete to the highlighted command. For arg-taking commands
        // we leave the menu open feel via trailing space (so the user
        // can keep typing); for arg-less commands we submit straight away.
        const picked = slashMatches[slashIdx]!;
        const completed = '/' + picked.name + (picked.args === 'none' ? '' : ' ');
        setInput(completed);
        setCursor(completed.length);
        setSlashIdx(0);
        if (key.return && picked.args === 'none') {
          // Submit immediately for no-arg commands.
          props.onSubmit(completed);
          setInput('');
          setCursor(0);
        }
        return;
      }
      if (key.escape) {
        // Close the menu without losing the typed text.
        setInput('');
        setCursor(0);
        return;
      }
      // Fall through for character / backspace edits so the user can
      // keep narrowing the filter.
    }
    if (key.return) {
      submit();
      return;
    }
    if (key.escape) {
      // When the agent is running, Esc is an interrupt (matches Ctrl+C
      // for the busy case but is more discoverable). When idle, Esc
      // clears the input field — pressing it never exits the app
      // (Ctrl+C on empty input is the only "exit" keystroke).
      if (state.busy) {
        props.onInterrupt();
        return;
      }
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
  }, { isActive: state.overlay === null });

  // Expose useApp's exit so the host can call ink.unmount() when done.
  useEffect(() => {
    return () => app.exit();
  }, [app]);

  // Hide the rail on narrow terminals — Bridge's rail is 32 columns; below
  // ~100 cols total the main column gets squished. Fall back to single
  // column. Below 60 cols, even the main padding is uncomfortable — keep
  // it readable.
  const showRail = columns >= 100;

  // Live model display — falls back to the props (set once at mount) if
  // the store hasn't received its first model update yet.
  const liveProvider = state.model.provider || props.modelProvider;
  const liveModel = state.model.name || props.modelName;

  // Active overlay: store-driven overlays (e.g. model picker) take
  // precedence; the slash menu is purely input-state driven.
  let overlay: React.ReactNode = null;
  if (state.overlay?.kind === 'model') {
    overlay = (
      <ModelPicker
        currentProvider={liveProvider}
        currentModel={liveModel}
        onPick={(m) => {
          props.onModelChange(m.provider, m.model);
          props.store.setOverlay(null);
        }}
        onCancel={() => props.store.setOverlay(null)}
      />
    );
  } else if (slashOpen) {
    overlay = <SlashMenu commands={slashMatches} selectedIdx={slashIdx} />;
  }

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
            modelProvider={liveProvider}
            modelName={liveModel}
            version={props.version}
          />
        )}
        <Main state={state} input={input} cursor={cursor} spinnerId={spinnerId} overlay={overlay} exitArmed={exitArmed} />
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
