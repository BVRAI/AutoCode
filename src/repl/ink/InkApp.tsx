// Ink Bridge app — the React tree that renders the full-screen Bridge
// TUI. Owns the input editor (text + cursor + history). Calls back into
// the controller (typically TerminalMode) for submit / mode-cycle / exit.

import React, { useEffect, useState, useCallback } from 'react';
import { Box, Text, useApp, useInput } from 'ink';
import { Rail } from './Rail.js';
import { Main } from './Main.js';
import { Inline } from './Inline.js';
import { ThemeContext, themeByName } from './theme.js';
import { useBridgeState, useTerminalSize } from './hooks.js';
import type { BridgeStore } from './store.js';
import type { SpinnerId } from './spinners.js';
import { bannerBlock, BANNER_GALLERY } from '../Banner.js';
import { ModelPicker } from './ModelPicker.js';
import { ProviderPicker } from './ProviderPicker.js';
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
  // 'inline' (default, flicker-free append-only) or 'cockpit' (full-screen rail).
  uiMode: 'inline' | 'cockpit';
  // Theme name ('dark' | 'light'); anything else falls back to dark.
  theme?: string;

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
    // ^P toggles the sticky plan panel between expanded and collapsed.
    if (key.ctrl && (ch === 'p' || ch === 'P')) {
      props.store.togglePlanCollapsed();
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
        // Submit immediately on Enter for commands whose no-args invocation
        // is meaningful — both `'none'` and `'optional'`. For `'optional'`
        // commands (/cwd, /model, /mode, /trash, /undo) the no-args form is
        // the most common invocation (e.g. /model opens the picker), so the
        // default Enter behaviour should fire it. Users who want to type
        // args still use Tab to complete-and-keep-typing. `'required'`
        // commands stay completion-only here because submitting them empty
        // would just error.
        if (key.return && (picked.args === 'none' || picked.args === 'optional')) {
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
  //
  // The model picker is two-stage. 'model-provider' lists providers; picking
  // one transitions to 'model-models' which lists that provider's rows. Esc
  // from 'model-models' goes BACK to 'model-provider' (not all the way out)
  // so the user can browse providers freely; Esc from 'model-provider'
  // closes the overlay.
  let overlay: React.ReactNode = null;
  if (state.overlay?.kind === 'model-provider') {
    overlay = (
      <ProviderPicker
        currentProvider={liveProvider}
        onPick={(provider) => props.store.setOverlay({ kind: 'model-models', provider })}
        onCancel={() => props.store.setOverlay(null)}
      />
    );
  } else if (state.overlay?.kind === 'model-models') {
    overlay = (
      <ModelPicker
        provider={state.overlay.provider}
        currentProvider={liveProvider}
        currentModel={liveModel}
        onPick={(m) => {
          props.onModelChange(m.provider, m.model);
          props.store.setOverlay(null);
        }}
        onBack={() => props.store.setOverlay({ kind: 'model-provider' })}
        onCancel={() => props.store.setOverlay(null)}
      />
    );
  } else if (slashOpen) {
    overlay = <SlashMenu commands={slashMatches} selectedIdx={slashIdx} />;
  }

  const theme = themeByName(props.theme);

  // Inline (default): append-only, no full-screen box, no alt-screen.
  if (props.uiMode !== 'cockpit') {
    return (
      <ThemeContext.Provider value={theme}>
        <Inline
          state={state}
          input={input}
          cursor={cursor}
          spinnerId={spinnerId}
          overlay={overlay}
          exitArmed={exitArmed}
          projectRoot={props.projectRoot}
          version={props.version}
          modelProvider={liveProvider}
          modelName={liveModel}
        />
      </ThemeContext.Provider>
    );
  }

  // Cockpit (opt-in): the original full-screen alt-screen rail + viewport.
  return (
    <ThemeContext.Provider value={theme}>
      <Box flexDirection="column" width={columns} height={rows}>
        {showBanner && (
          <Box flexDirection="column" paddingX={2}>
            {bannerBlock(WELCOME_BANNER).map((line, i) => (
              <Text key={i} color={theme.accent}>{line}</Text>
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
    </ThemeContext.Provider>
  );
}

// Synchronized output (DEC private mode 2026): bracket each frame Ink writes
// so the terminal buffers the erase+repaint and presents it atomically. Ink's
// renderer repaints the whole full-screen frame on every state change (e.g.
// each keystroke), which otherwise shows as flicker; with synchronized output
// the user only ever sees the finished frame. Terminals that don't support the
// mode ignore the markers (no-op), so it's safe everywhere. Ink ≥6.7 emits
// these itself; we're on Ink 5, so we wrap the output stream.
const SYNC_BEGIN = '\x1b[?2026h';
const SYNC_END = '\x1b[?2026l';

function withSynchronizedOutput(base: NodeJS.WriteStream): NodeJS.WriteStream {
  return new Proxy(base, {
    get(target, prop, receiver) {
      if (prop === 'write') {
        return (chunk: unknown, ...rest: unknown[]): boolean => {
          const s = typeof chunk === 'string' ? chunk : (chunk as Buffer).toString();
          return (target.write as (...a: unknown[]) => boolean)(SYNC_BEGIN + s + SYNC_END, ...rest);
        };
      }
      const value = Reflect.get(target, prop, receiver) as unknown;
      return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  }) as NodeJS.WriteStream;
}

// One-stop mount helper. Returns the Ink render instance — call
// `instance.unmount()` to exit cleanly. Manages alt-screen takeover
// (Bridge owns the full window for its lifetime, exits cleanly back to
// the user's shell with prior scrollback intact).
export async function mountInkApp(props: InkAppProps): Promise<{ unmount: () => void; waitUntilExit: () => Promise<void> }> {
  const { render } = await import('ink');
  // Alt-screen is ONLY for cockpit mode (it owns the full window). Inline mode
  // renders append-only into the normal scrollback — no takeover, no clear.
  const altScreen = props.uiMode === 'cockpit';
  if (altScreen) process.stdout.write('\x1b[?1049h\x1b[H\x1b[2J');
  let exited = false;
  const restore = (): void => {
    if (exited) return;
    exited = true;
    try {
      if (altScreen) process.stdout.write('\x1b[?1049l');
    } catch {
      /* shell already closed */
    }
  };
  const inst = render(<InkApp {...props} />, {
    // Synchronized output only helps (and only belongs in) the full-screen
    // cockpit, where the whole frame repaints. In inline mode it interferes
    // with Ink's <Static> scrollback (stranding ghost frames), so use the
    // raw stream there.
    stdout: altScreen ? withSynchronizedOutput(process.stdout) : process.stdout,
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
