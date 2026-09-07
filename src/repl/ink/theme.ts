// Theme — role-named palettes (DARK default + LIGHT) with an identical key-set
// so a component can take a `t` (theme) object and never branch on light/dark.
// Revised from the original BR palette per the Claude Design handoff
// (_context_only/design-upgrades/autocode-tui-design/tui/core.jsx).
//
// Terminal note: the design's translucent roles (codeBg/addBg/delBg/liveBg are
// rgba over bg) can't alpha-blend in a terminal, so they're pre-blended into
// SOLID hexes here (computed once over each theme's bg).

import React from 'react';

export interface Theme {
  name: 'dark' | 'light';
  // surfaces
  bg: string;
  panel: string;
  rail: string;
  // text
  ink: string;
  inkDim: string;
  inkFaint: string;
  // lines
  rule: string;
  ruleStrong: string;
  // brand / semantic
  accent: string; // teal — brand, prompts, links
  accentDim: string;
  agent: string; // violet — the assistant
  add: string; // additions, success
  del: string; // deletions, errors
  warn: string; // warnings, planning, ctx >= 80%
  amber: string; // running / in-progress
  rose: string; // hard errors
  // solid backgrounds (pre-blended from the design's rgba tints)
  codeBg: string;
  addBg: string;
  delBg: string;
  liveBg: string;
  cursorInk: string; // text color under the block cursor
  // terminal-window chrome (cockpit framing only)
  chrome: string;
  chromeRule: string;
  chromeInk: string;
  // Claude Code transcript roles
  userBand: string;    // tinted band behind the user's turn
  border: string;      // composer / welcome border (manual mode)
  borderPlan: string;  // composer border in plan mode
  borderAuto: string;  // composer border in auto mode
  permission: string;  // permission dialog border
  thinkingInk: string; // live thinking text
  // ── back-compat aliases (old BR key names) so components migrate gradually ──
  teal: string;
  tealDim: string;
  violet: string;
  yellow: string;
}

export const DARK: Theme = {
  name: 'dark',
  bg: '#0a0d0d',
  panel: '#0d1112',
  rail: '#0c1011',
  ink: '#e5ecec',
  inkDim: '#8f9b9b', // 6.5:1 on Automax's #0F1115 — the tier for secondary TEXT
  inkFaint: '#5c6666', // decoration only (rules, bars) — never for text
  rule: '#1a2122',
  ruleStrong: '#3a4648',
  accent: '#3dd9c4',
  accentDim: '#1e7d72',
  agent: '#c98ce0',
  add: '#7dd181',
  del: '#e36a6a',
  warn: '#e8c75e',
  amber: '#e8a64a',
  rose: '#e36a6a',
  codeBg: '#0f211f', // teal 10% over bg
  addBg: '#121b15', // green 7% over bg
  delBg: '#191414', // red 7% over bg
  liveBg: '#0c1413', // teal 3.5% over bg
  cursorInk: '#0a0d0d',
  chrome: '#16191a',
  chromeRule: '#232727',
  chromeInk: '#9aa3a3',
  userBand: '#1e2628',
  border: '#4b5658',
  borderPlan: '#8fb3d9',
  borderAuto: '#5fb87a',
  permission: '#e8a64a',
  thinkingInk: '#8f9b9b',
  // aliases
  teal: '#3dd9c4',
  tealDim: '#1e7d72',
  violet: '#c98ce0',
  yellow: '#e8c75e',
};

export const LIGHT: Theme = {
  name: 'light',
  bg: '#f6f3ec',
  panel: '#efeadf',
  rail: '#efeadf',
  ink: '#1d2422',
  inkDim: '#5c6863', // 5.8:1 on white — the tier for secondary TEXT
  inkFaint: '#9aa49d', // decoration only — never for text
  rule: '#e1dbcd',
  ruleStrong: '#b9b3a3',
  accent: '#0a6f64', // ≥ 4.5:1 on pure white (Automax's light pane is white, not cream)
  accentDim: '#0a5a51',
  agent: '#7a3f9c',
  add: '#2f7a3f',
  del: '#b8433a',
  warn: '#8a6912',
  amber: '#93601a',
  rose: '#c0463c',
  codeBg: '#dae7df', // teal 12% over paper
  addBg: '#e3e8dc', // green 10% over paper
  delBg: '#f1e3dc', // red 9% over paper
  liveBg: '#eaeee7', // teal 5% over paper
  cursorInk: '#f6f3ec',
  chrome: '#e7e1d4',
  chromeRule: '#d3ccbc',
  chromeInk: '#6b756e',
  userBand: '#e9ecef',
  border: '#9aa4a0',
  borderPlan: '#3f6fa3',
  borderAuto: '#2f7a3f',
  permission: '#93601a',
  thinkingInk: '#5c6863',
  // aliases
  teal: '#0a6f64',
  tealDim: '#0a5a51',
  violet: '#7a3f9c',
  yellow: '#8a6912',
};

export const THEMES: Record<Theme['name'], Theme> = { dark: DARK, light: LIGHT };

export function themeByName(name: string | undefined): Theme {
  return name === 'light' ? LIGHT : DARK;
}

// Which theme to run: a host hint wins (Automax sets AUTOMAX_THEME=light|dark
// when it launches the CLI in its terminal pane, which is the only way the CLI
// can know the pane's background), then the user's saved `/ui` choice, then
// dark. Anything unrecognised in the hint is ignored rather than trusted.
export function resolveThemeName(
  hostValue: string | undefined,
  configValue: string | undefined,
): Theme['name'] {
  const host = hostValue?.trim().toLowerCase();
  if (host === 'light' || host === 'dark') return host;
  return configValue === 'light' ? 'light' : 'dark';
}

// React context so the whole tree reads one active theme. Default DARK.
export const ThemeContext = React.createContext<Theme>(DARK);

export function useTheme(): Theme {
  return React.useContext(ThemeContext);
}

// Back-compat: `BR` is the dark theme. Existing components that still import
// `BR` keep rendering (in dark) until migrated to `useTheme()`.
export const BR = DARK;
