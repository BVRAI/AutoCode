// React hooks for the Ink Bridge UI. Thin glue between the BridgeStore
// (plain TS, no React) and the Ink components.

import { useEffect, useState } from 'react';
import type { BridgeState, BridgeStore } from './store.js';

// Subscribe to the full state. Re-renders on any change. Cheap because
// updates are immutable references — React's identity check is enough.
export function useBridgeState(store: BridgeStore): BridgeState {
  const [s, setS] = useState<BridgeState>(store.get());
  useEffect(() => store.subscribe(setS), [store]);
  return s;
}

// Wall-clock ticker — returns the current frame index, increments every
// `intervalMs`. Used by spinner components.
export function useTick(intervalMs = 90): number {
  const [t, setT] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setT((x) => x + 1), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return t;
}

// Live terminal columns/rows — Ink already exposes a similar hook, but we
// also need to reach state from non-component code (e.g. layout decisions
// outside React). Wraps stdout.columns/rows + 'resize' listener.
export function useTerminalSize(): { columns: number; rows: number } {
  const [size, setSize] = useState<{ columns: number; rows: number }>(() => ({
    columns: process.stdout.columns || 100,
    rows: process.stdout.rows || 30,
  }));
  useEffect(() => {
    const onResize = (): void =>
      setSize({ columns: process.stdout.columns || 100, rows: process.stdout.rows || 30 });
    process.stdout.on('resize', onResize);
    return () => {
      process.stdout.off('resize', onResize);
    };
  }, []);
  return size;
}
