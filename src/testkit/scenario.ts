// Scenario runner — one JSON file drives a console session step by step and
// collects screen snapshots. The same schema is executed inside Automax by the
// console door (v6/tools/console-door), so a scenario proves both channels.
//
// {
//   "cols": 100, "rows": 30, "theme": "dark", "mode": "autocode",
//   "fake": "./basic.fake.json",            // FakeProvider script, relative to this file
//   "project": "../fixtures/project",       // copied fresh for every run
//   "steps": [
//     { "waitFor": "/help for commands" },
//     { "type": "add a --verbose flag" }, { "key": "enter" },
//     { "waitFor": "TURN_END", "timeoutMs": 30000 },
//     { "snapshot": "after-turn" },
//     { "resize": [80, 24] }, { "waitIdle": 600 }, { "snapshot": "after-resize" }
//   ]
// }

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { TtySession, TURN_END, type TtyBackend, type TtyOptions } from './tty.js';

export type ScenarioStep =
  | { type: string }
  | { key: string }
  | { keys: string[] }
  | { write: string }
  | { paste: string }
  | { waitFor: string; timeoutMs?: number }
  | { waitIdle: number; timeoutMs?: number }
  | { sleep: number }
  | { resize: [number, number] }
  | { snapshot: string };

export interface Scenario {
  cols?: number;
  rows?: number;
  theme?: 'dark' | 'light';
  mode?: TtyOptions['mode'];
  fake?: string;
  project: string;
  steps: ScenarioStep[];
}

export interface Snapshot {
  name: string;
  cols: number;
  rows: number;
  screen: string[];
  scrollback: string[];
}

export interface ScenarioResult {
  backend: TtyBackend;
  snapshots: Snapshot[];
}

export function loadScenario(path: string): { scenario: Scenario; dir: string } {
  const abs = resolve(path);
  const scenario = JSON.parse(readFileSync(abs, 'utf8')) as Scenario;
  if (!Array.isArray(scenario.steps)) throw new Error(`${path}: "steps" must be an array`);
  if (!scenario.project) throw new Error(`${path}: "project" is required`);
  return { scenario, dir: dirname(abs) };
}

export async function runScenario(
  path: string,
  overrides: Partial<Pick<Scenario, 'cols' | 'rows' | 'theme' | 'mode'>> & { backend?: TtyBackend } = {},
  onSnapshot?: (snap: Snapshot) => void,
): Promise<ScenarioResult> {
  const { scenario, dir } = loadScenario(path);
  const session = await TtySession.start({
    project: resolve(dir, scenario.project),
    cols: overrides.cols ?? scenario.cols ?? 100,
    rows: overrides.rows ?? scenario.rows ?? 30,
    theme: overrides.theme ?? scenario.theme ?? 'dark',
    mode: overrides.mode ?? scenario.mode ?? 'autocode',
    fakeScript: scenario.fake ? resolve(dir, scenario.fake) : undefined,
    backend: overrides.backend,
  });
  const snapshots: Snapshot[] = [];
  try {
    for (const step of scenario.steps) {
      if ('type' in step) await session.type(step.type);
      else if ('key' in step) await session.key(step.key);
      else if ('keys' in step) for (const k of step.keys) await session.key(k);
      else if ('write' in step) session.write(step.write);
      else if ('paste' in step) await session.paste(step.paste);
      else if ('waitFor' in step) await session.waitFor(patternFor(step.waitFor), step.timeoutMs ?? 20_000);
      else if ('waitIdle' in step) await session.waitIdle(step.waitIdle, step.timeoutMs ?? 20_000);
      else if ('sleep' in step) await new Promise((r) => setTimeout(r, step.sleep));
      else if ('resize' in step) await session.resize(step.resize[0], step.resize[1]);
      else if ('snapshot' in step) {
        await session.flush();
        const { cols, rows } = session.size();
        const snap: Snapshot = { name: step.snapshot, cols, rows, screen: session.screen(), scrollback: session.scrollback() };
        snapshots.push(snap);
        onSnapshot?.(snap);
      }
    }
  } finally {
    await session.stop();
  }
  return { backend: session.backend, snapshots };
}

function patternFor(spec: string): RegExp | string {
  if (spec === 'TURN_END') return TURN_END;
  const m = /^\/(.+)\/([gimsuy]*)$/.exec(spec);
  return m ? new RegExp(m[1]!, m[2]) : spec;
}

/**
 * Replace the parts of a screen that legitimately differ between runs
 * (durations, clock, token counts, costs, temp paths) so goldens are stable.
 */
export function normalizeScreen(lines: string[]): string[] {
  return lines.map((l) =>
    l
      .replace(/\b\d+h(?: \d+m)?\b/g, '#DUR')
      .replace(/\b\d+m(?: \d+s)?\b/g, '#DUR')
      .replace(/\b\d+(?:\.\d+)?s\b/g, '#DUR')
      .replace(/\b\d{1,2}:\d{2} [AP]M\b/g, '#CLOCK')
      .replace(/↓ [\d.]+k? tokens/g, '↓ #TOK tokens')
      .replace(/\$\d+\.\d+/g, '$#COST')
      .replace(/\(\d+ms\)/g, '(#MS)')
      .replace(/[✢✳✶✻✽]/g, '✻'),
  );
}
