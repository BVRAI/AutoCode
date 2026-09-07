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

// Light palette on Gregory's rule for Automax's light mode: text is black,
// the semantic colors are dark red / dark blue / dark green, and a yellow
// highlight (with bold or italics) marks the few things that need emphasis —
// here the band behind the user's own turn. Every text color clears 4.5:1
// on pure white (Automax's light pane is white, not cream).
export const LIGHT: Theme = {
  name: 'light',
  bg: '#ffffff',
  panel: '#f4f4f4',
  rail: '#f4f4f4',
  ink: '#000000',
  inkDim: '#4a4a4a', // 9.7:1 on white — the tier for secondary TEXT
  inkFaint: '#9a9a9a', // decoration only — never for text
  rule: '#dcdcdc',
  ruleStrong: '#b0b0b0',
  accent: '#1a44a8', // dark blue — brand, prompts, links
  accentDim: '#153a8c',
  agent: '#1a44a8', // the assistant's glyphs share the dark blue
  add: '#1e6b2e', // dark green
  del: '#a11a1a', // dark red
  warn: '#7a5a00', // dark yellow text (warnings, planning, context ≥ 80%)
  amber: '#7a5a00',
  rose: '#a11a1a',
  codeBg: '#efefef', // neutral gray behind code
  addBg: '#e2f0e4', // green 10% over white
  delBg: '#f6e1e1', // red 9% over white
  liveBg: '#f3f3f3',
  cursorInk: '#ffffff',
  chrome: '#ebebeb',
  chromeRule: '#d0d0d0',
  chromeInk: '#4a4a4a',
  userBand: '#fff3a3', // yellow highlight behind the user's turn
  border: '#8c8c8c',
  borderPlan: '#1a44a8',
  borderAuto: '#1e6b2e',
  permission: '#7a5a00',
  thinkingInk: '#4a4a4a',
  // aliases
  teal: '#1a44a8',
  tealDim: '#153a8c',
  violet: '#1a44a8',
  yellow: '#7a5a00',
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
