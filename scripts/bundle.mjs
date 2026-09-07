#!/usr/bin/env node
// Build a self-contained copy of the harness for a host to ship (Phase 5.3):
//
//   <out>/
//     node.exe            the Node runtime this script runs under (node on POSIX)
//     dist/               the compiled harness
//     node_modules/       production dependencies only
//     package.json
//     autocode.cmd / autocode   launchers: <out>/node <out>/dist/cli.js "$@"
//
// Usage: node scripts/bundle.mjs --out <dir> [--no-build]
// Automax's Release build runs it into Resources/autocode/, where
// CodingHarnessCatalog.TryResolveBundled looks first.

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const outIdx = args.indexOf('--out');
if (outIdx < 0 || !args[outIdx + 1]) {
  console.error('usage: node scripts/bundle.mjs --out <dir> [--no-build]');
  process.exit(2);
}
const out = resolve(args[outIdx + 1]);
const build = !args.includes('--no-build');

const run = (cmd, cmdArgs, cwd = root) => execFileSync(cmd, cmdArgs, { cwd, stdio: 'inherit', shell: process.platform === 'win32' });

if (build) run('npm', ['run', 'build']);
if (!existsSync(join(root, 'dist', 'cli.js'))) {
  console.error('dist/cli.js missing — run npm run build first');
  process.exit(1);
}

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

// Production node_modules: install from the lockfile into the bundle itself so
// native prebuilds (keytar) land in place; dev tooling (vitest, node-pty,
// typescript) stays out.
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const slim = { name: pkg.name, version: pkg.version, type: pkg.type, bin: pkg.bin, dependencies: pkg.dependencies, engines: pkg.engines };
writeFileSync(join(out, 'package.json'), JSON.stringify(slim, null, 2));
cpSync(join(root, 'package-lock.json'), join(out, 'package-lock.json'));
run('npm', ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], out);
// keytar and other natives ship prebuilds under their own package; run their
// install scripts only for the packages that need them.
try {
  run('npm', ['rebuild', 'keytar'], out);
} catch {
  /* keytar prebuild missing: SecretStore falls back to plaintext config */
}
rmSync(join(out, 'package-lock.json'), { force: true });

cpSync(join(root, 'dist'), join(out, 'dist'), { recursive: true });
for (const extra of ['README.md', 'LICENSE', 'CHANGELOG.md']) {
  if (existsSync(join(root, extra))) cpSync(join(root, extra), join(out, extra));
}

// The runtime: the exact Node this script runs under.
const nodeName = process.platform === 'win32' ? 'node.exe' : 'node';
cpSync(process.execPath, join(out, nodeName));

// Launchers.
writeFileSync(join(out, 'autocode.cmd'), '@echo off\r\n"%~dp0node.exe" "%~dp0dist\\cli.js" %*\r\n');
const sh = '#!/bin/sh\nDIR="$(cd "$(dirname "$0")" && pwd)"\nexec "$DIR/node" "$DIR/dist/cli.js" "$@"\n';
writeFileSync(join(out, 'autocode'), sh);
try {
  chmodSync(join(out, 'autocode'), 0o755);
} catch {
  /* windows */
}

const version = pkg.version;
writeFileSync(join(out, 'BUNDLE.json'), JSON.stringify({ name: pkg.name, version, node: process.version, builtAt: new Date().toISOString() }, null, 2));
console.log(`bundled ${pkg.name}@${version} with ${process.version} into ${out}`);
