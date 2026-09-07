// Ink Bridge app — the React tree that renders the full-screen Bridge
// TUI. Owns the input editor (text + cursor + history). Calls back into
// the controller (typically TerminalMode) for submit / mode-cycle / exit.

import React, { useEffect, useState, useCallback, useRef } from 'react';
import { Box, useApp, useInput } from 'ink';
import { Rail, RAIL_COMPACT_WIDTH, RAIL_WIDTH } from './Rail.js';
import { Main } from './Main.js';
import { Inline } from './Inline.js';
import { ThemeContext, themeByName } from './theme.js';
import { useBridgeState, useTerminalSize } from './hooks.js';
import type { BridgeStore } from './store.js';
import type { SpinnerId } from './spinners.js';
import { ModelPicker } from './ModelPicker.js';
import { ProviderPicker } from './ProviderPicker.js';
import { KeyManager } from './KeyManager.js';
import { SlashMenu } from './SlashMenu.js';
import { CwdPreview } from './CwdPreview.js';
import { PromptOverlay } from './PromptOverlay.js';
import { filterCommands } from '../commands.js';

export interface InkAppHandle {
  // Imperative API the controller uses to drive the UI from outside React.
  setSpinnerId(id: SpinnerId): void;
  setExitCallback(cb: () => void): void;
}

// The composer's text survives a remount (inline mode rebuilds the whole
// transcript from source on resize): the host owns this object and the app
// mirrors its input state into it.
export interface ComposerDraft {
  input: string;
  cursor: number;
  history: string[];
}

export interface InkAppProps {
  store: BridgeStore;
  draft?: ComposerDraft;
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
  // BYOK key-manager overlay actions (the /keys flow).
  onSaveKey: (provider: string, apiKey: string) => Promise<void>;
  onRemoveKey: (provider: string) => Promise<void>;
}

export function InkApp(props: InkAppProps): React.JSX.Element {
  const state = useBridgeState(props.store);
  const { columns, rows } = useTerminalSize();
  const [spinnerId, setSpinnerId] = useState<SpinnerId>('braille');
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

  const app = useApp();

  const [input, setInput] = useState<string>(props.draft?.input ?? '');
  const [cursor, setCursor] = useState<number>(props.draft?.cursor ?? 0);
  const [history, setHistory] = useState<string[]>(props.draft?.history ?? []);
  const [histPos, setHistPos] = useState<number>(-1);
  useEffect(() => {
    const d = props.draft;
    if (!d) return;
    d.input = input;
    d.cursor = cursor;
    d.history = history;
  }, [props.draft, input, cursor, history]);
  const [scrollOffset, setScrollOffset] = useState<number>(0);
  const previousItemCount = useRef<number>(state.items.length);
  // Slash menu state — opens when input starts with `/` and the user
  // hasn't already finished typing a complete command name + space.
  const [slashIdx, setSlashIdx] = useState<number>(0);
  // Ctrl+C double-press protection. Pressing Ctrl+C on empty input
  // arms a 3-second window; a second Ctrl+C within that window exits.
  // Prevents accidental exits during long coding ops. Esc remains the
  // interrupt-the-agent keystroke.
  const [exitArmed, setExitArmed] = useState<boolean>(false);

  const submit = useCallback((override?: string) => {
    const text = override ?? input;
    if (text.trim().length === 0) return;
    setHistory((h) => [...h, text]);
    setHistPos(-1);
    setInput('');
    setCursor(0);
    setSlashIdx(0);
    setScrollOffset(0);
    props.onSubmit(text);
  }, [input, props]);

  const maxScrollOffset = Math.max(0, state.items.length - 1);
  const pageScrollStep = Math.max(3, Math.floor(rows / 3));
  const wheelScrollStep = Math.max(1, Math.floor(rows / 10));
  const scrollHistory = useCallback((delta: number) => {
    setScrollOffset((offset) => Math.max(0, Math.min(maxScrollOffset, offset + delta)));
  }, [maxScrollOffset]);

  useEffect(() => {
    const previous = previousItemCount.current;
    const current = state.items.length;
    previousItemCount.current = current;
    const delta = current - previous;
    if (delta > 0) {
      setScrollOffset((offset) => offset > 0 ? Math.min(maxScrollOffset, offset + delta) : 0);
    } else if (delta < 0) {
      setScrollOffset((offset) => Math.min(offset, maxScrollOffset));
    }
  }, [maxScrollOffset, state.items.length]);

  useEffect(() => {
    if (props.uiMode !== 'cockpit' || !process.stdout.isTTY) return;
    const enableMouse = '\u001B[?1000h\u001B[?1006h';
    const disableMouse = '\u001B[?1006l\u001B[?1000l';
    process.stdout.write(enableMouse);
    return () => {
      process.stdout.write(disableMouse);
    };
  }, [props.uiMode]);

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
    if (props.uiMode === 'cockpit') {
      const mouse = parseMouseInput(ch);
      if (mouse.isMouse) {
        if (mouse.wheelDelta !== 0) {
          scrollHistory(mouse.wheelDelta * wheelScrollStep);
        }
        return;
      }
      if (key.pageUp) {
        scrollHistory(pageScrollStep);
        return;
      }
      if (key.pageDown) {
        scrollHistory(-pageScrollStep);
        return;
      }
      if (key.home) {
        setScrollOffset(maxScrollOffset);
        return;
      }
      if (key.end) {
        setScrollOffset(0);
        return;
      }
    }

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
    // Ctrl+T toggles the todo tray (Claude Code's binding); ^P kept as an alias.
    if (key.ctrl && (ch === 't' || ch === 'T' || ch === 'p' || ch === 'P')) {
      props.store.togglePlanCollapsed();
      return;
    }
    // Ctrl+O: results commit expanded instead of collapsed (Claude Code's
    // verbose toggle). Applies to rows committed from now on.
    if (key.ctrl && (ch === 'o' || ch === 'O')) {
      props.store.toggleVerbose();
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
      // Ink keeps `\r` inside a multi-character chunk, so a fast typist, a
      // paste or ConPTY coalescing can deliver "text\r" as one event: insert
      // the text, then treat the newline as Enter.
      const nl = ch.search(/[\r\n]/);
      if (nl >= 0) {
        const next = input.slice(0, cursor) + ch.slice(0, nl) + input.slice(cursor);
        if (next.trim().length > 0) submit(next);
        else {
          setInput(next);
          setCursor(cursor + nl);
        }
        return;
      }
      setInput((s) => s.slice(0, cursor) + ch + s.slice(cursor));
      setCursor((c) => c + ch.length);
    }
  }, { isActive: state.overlay === null });

  // Expose useApp's exit so the host can call ink.unmount() when done.
  useEffect(() => {
    return () => app.exit();
  }, [app]);

  // Keep cockpit visually distinct on medium terminals: the rail only
  // disappears when the main chat would become too narrow to use.
  const showRail = columns >= 56;
  const railWidth = columns >= 104 ? RAIL_WIDTH : columns >= 72 ? RAIL_COMPACT_WIDTH : 20;

  // Live model display — falls back to the props (set once at mount) if
  // the store hasn't received its first model update yet.
  const liveProvider = state.model.provider || props.modelProvider;
  const liveModel = state.model.name || props.modelName;
  const liveProjectRoot = state.project.root || props.projectRoot;
  const cwdPreviewArg = cwdPreviewArgForInput(input);

  // Active overlay: store-driven overlays (e.g. model picker) take
  // precedence; the slash menu is purely input-state driven.
  //
  // The model picker is two-stage. 'model-provider' lists providers; picking
  // one transitions to 'model-models' which lists that provider's rows. Esc
  // from 'model-models' goes BACK to 'model-provider' (not all the way out)
  // so the user can browse providers freely; Esc from 'model-provider'
  // closes the overlay.
  let overlay: React.ReactNode = null;
  if (state.overlay?.kind === 'prompt') {
    // Interactive prompt (approval / confirm / choose / ask) — highest
    // precedence: the agent is blocked awaiting the user's answer.
    overlay = <PromptOverlay request={state.overlay.request} />;
  } else if (state.overlay?.kind === 'model-provider') {
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
  } else if (state.overlay?.kind === 'byok') {
    overlay = (
      <KeyManager
        onSave={props.onSaveKey}
        onRemove={props.onRemoveKey}
        onClose={() => props.store.setOverlay(null)}
      />
    );
  } else if (cwdPreviewArg !== null) {
    overlay = <CwdPreview currentRoot={liveProjectRoot} rawArg={cwdPreviewArg} />;
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
          projectRoot={liveProjectRoot}
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
        <Box flexDirection="row" flexGrow={1}>
          {showRail && (
            <Rail
              state={state}
              sessionId={props.sessionId}
              projectRoot={liveProjectRoot}
              modelProvider={liveProvider}
              modelName={liveModel}
              version={props.version}
              width={railWidth}
            />
          )}
          <Main
            key={`${columns}x${rows}:${showRail ? railWidth : 0}`}
            state={state}
            input={input}
            cursor={cursor}
            spinnerId={spinnerId}
            overlay={overlay}
            exitArmed={exitArmed}
            rows={rows}
            columns={showRail ? columns - railWidth : columns}
            scrollOffset={scrollOffset}
            maxScrollOffset={maxScrollOffset}
          />
        </Box>
      </Box>
    </ThemeContext.Provider>
  );
}

function cwdPreviewArgForInput(input: string): string | null {
  const slash = /^\/cwd\s+(.*)$/i.exec(input);
  if (slash) return slash[1] ?? '';
  const cd = /^cd\s+(.*)$/i.exec(input);
  if (cd) return cd[1] ?? '';
  return null;
}

function parseMouseInput(input: string): { isMouse: boolean; wheelDelta: number } {
  const match = /^\[<(\d+);\d+;\d+[mM]$/.exec(input);
  if (!match) return { isMouse: false, wheelDelta: 0 };
  const button = Number(match[1]);
  if (!Number.isFinite(button) || (button & 64) === 0) return { isMouse: true, wheelDelta: 0 };
  const direction = button & 3;
  if (direction === 0) return { isMouse: true, wheelDelta: 1 };
  if (direction === 1) return { isMouse: true, wheelDelta: -1 };
  return { isMouse: true, wheelDelta: 0 };
}

// One-stop mount helper. Returns the Ink render instance — call
// `instance.unmount()` to exit cleanly. Manages alt-screen takeover
// (Bridge owns the full window for its lifetime, exits cleanly back to
// the user's shell with prior scrollback intact).
export async function mountInkApp(props: InkAppProps): Promise<{ unmount: () => void; waitUntilExit: () => Promise<void> }> {
  const { render } = await import('ink');
  // Alt-screen is ONLY for cockpit mode (it owns the full window). Ink 7 owns
  // the screen-buffer lifecycle, including cleanup on unmount/process exit.
  const altScreen = props.uiMode === 'cockpit';
  const { emulatedStdin } = await import('../../util/ttyEmulation.js');
  const inst = render(<InkApp {...props} />, {
    stdout: process.stdout,
    // Emulated-TTY tests read a filtered stdin (resize OSC applied there).
    stdin: emulatedStdin(),
    exitOnCtrlC: false,
    patchConsole: false,
    maxFps: altScreen ? 20 : 30,
    incrementalRendering: altScreen,
    alternateScreen: altScreen,
    interactive: true,
  });
  return {
    unmount: () => {
      inst.unmount();
    },
    waitUntilExit: async () => {
      await inst.waitUntilExit();
    },
  };
}
