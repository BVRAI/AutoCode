#!/usr/bin/env node
// Print the screens of a scenario, so a console change can be looked at
// without writing a test. Needs `npm run build` first (imports dist/).
//
//   node scripts/tty.mjs --scenario basic [--cols 100] [--rows 30]
//        [--theme dark|light] [--mode autocode|default|planning] [--backend pty|emulated]
//        [--scrollback]   (print the whole buffer, not just the visible rows)

import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const { runScenario } = await import(`file://${root.replace(/\\/g, '/')}/dist/testkit/scenario.js`);

const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : def;
};
const flag = (name) => args.includes(`--${name}`);

const spec = opt('scenario', 'basic');
const path = existsSync(spec) ? spec : resolve(root, 'test', 'e2e', 'scenarios', spec.endsWith('.json') ? spec : `${spec}.json`);
const overrides = {};
if (opt('cols')) overrides.cols = Number(opt('cols'));
if (opt('rows')) overrides.rows = Number(opt('rows'));
if (opt('theme')) overrides.theme = opt('theme');
if (opt('mode')) overrides.mode = opt('mode');
if (opt('backend')) overrides.backend = opt('backend');
const showScrollback = flag('scrollback');

const started = Date.now();
try {
  const result = await runScenario(path, overrides, (snap) => {
    const rows = showScrollback ? snap.scrollback : snap.screen;
    const rule = '─'.repeat(Math.min(snap.cols, 100));
    console.log(`\n┌${rule}┐  ${snap.name} · ${snap.cols}×${snap.rows}`);
    for (const line of rows) console.log(`│${line}`);
    console.log(`└${rule}┘`);
  });
  console.log(`\n[${result.backend}] ${result.snapshots.length} snapshot(s) in ${((Date.now() - started) / 1000).toFixed(1)}s`);
  // node-pty's ConPTY worker keeps the loop alive after the child is gone.
  process.exit(0);
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}
