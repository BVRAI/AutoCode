// Spinner gallery — eight frame-based presets + two "process" spinners
// (Pipeline: multi-stage horizontal stepper; Reactor: 5-line rotating
// ASCII core). All Ink-only. The plain stderr Spinner.ts is kept for the
// non-TTY path.

import React from 'react';
import { Box, Text } from 'ink';
import { useTick } from './hooks.js';

export type SpinnerId =
  | 'braille'
  | 'pulse'
  | 'orbit'
  | 'arc'
  | 'dots'
  | 'heartbeat'
  | 'bars'
  | 'shimmer'
  | 'pipeline'
  | 'reactor';

export interface SpinnerPreset {
  id: SpinnerId;
  title: string;
  desc: string;
  frames: string[];   // empty for custom (shimmer, pipeline, reactor)
  speed: number;
}

export const SPINNERS: SpinnerPreset[] = [
  {
    id: 'braille',
    title: 'braille',
    desc: 'the default — quiet, dense, works everywhere',
    frames: ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'],
    speed: 90,
  },
  {
    id: 'pulse',
    title: 'pulse',
    desc: 'vertical wave — feels alive without being noisy',
    frames: ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '▆', '▅', '▄', '▃', '▂'],
    speed: 80,
  },
  {
    id: 'orbit',
    title: 'orbit',
    desc: 'quarter-circle rotation — confident, mechanical',
    frames: ['◐', '◓', '◑', '◒'],
    speed: 110,
  },
  {
    id: 'arc',
    title: 'arc',
    desc: 'six-arc rotation — softer than orbit',
    frames: ['◜', '◠', '◝', '◞', '◡', '◟'],
    speed: 110,
  },
  {
    id: 'dots',
    title: 'dots',
    desc: 'accumulating dots, then reset — slow, ambient',
    frames: ['   ', '·  ', '·· ', '···', ' ··', '  ·'],
    speed: 130,
  },
  {
    id: 'heartbeat',
    title: 'heartbeat',
    desc: 'gentle expand/contract — implies thought',
    frames: ['◇', '◈', '◆', '◈'],
    speed: 160,
  },
  {
    id: 'bars',
    title: 'bars',
    desc: 'three-cell phase shift — punchy',
    frames: ['▏', '▎', '▍', '▌', '▋', '▊', '▉', '█', '▉', '▊', '▋', '▌', '▍', '▎'],
    speed: 70,
  },
  {
    id: 'shimmer',
    title: 'shimmer',
    desc: 'glyphless — a block drifting horizontally',
    frames: [],
    speed: 80,
  },
];

export function getPreset(id: SpinnerId): SpinnerPreset | undefined {
  return SPINNERS.find((s) => s.id === id);
}

const TEAL = '#3dd9c4';

// Generic frame-driven spinner. The `id` field picks the frame set; custom
// shapes (shimmer / pipeline / reactor) route through their own renderers.
export function Spinner({ id = 'braille', color = TEAL }: { id?: SpinnerId; color?: string }): React.JSX.Element {
  if (id === 'shimmer') return <Shimmer color={color} />;
  if (id === 'pipeline') return <PipelineGlyph color={color} />;
  if (id === 'reactor') return <ReactorGlyph color={color} />;
  const preset = getPreset(id) ?? SPINNERS[0]!;
  const t = useTick(preset.speed);
  return <Text color={color}>{preset.frames[t % preset.frames.length]}</Text>;
}

// Shimmer — single block drifting L→R, fading wake. ~10 cells wide.
function Shimmer({ color }: { color: string }): React.JSX.Element {
  const t = useTick(80);
  const width = 10;
  const pos = t % (width + 2);
  const cells: React.ReactNode[] = [];
  for (let i = 0; i < width; i++) {
    const d = Math.abs(i - pos);
    let ch = ' ';
    if (d === 0) ch = '█';
    else if (d === 1) ch = '▓';
    else if (d === 2) ch = '▒';
    cells.push(
      <Text key={i} color={d <= 2 ? color : '#1c2222'}>
        {ch}
      </Text>,
    );
  }
  return <Box>{cells}</Box>;
}

// Pipeline (compact glyph form — for inline use). Use <Pipeline stages=…/>
// for the full multi-stage stepper.
function PipelineGlyph({ color }: { color: string }): React.JSX.Element {
  const frame = useTick(110);
  const frames = ['◐', '◓', '◑', '◒'];
  return <Text color={color}>{frames[frame % frames.length]}</Text>;
}

// Reactor glyph (compact — for inline use). The full 5-line ASCII core
// uses the <Reactor/> component.
function ReactorGlyph({ color }: { color: string }): React.JSX.Element {
  const t = useTick(110);
  const ticks = ['╱', '─', '╲', '│'];
  return <Text color={color}>{ticks[t % ticks.length]}</Text>;
}

// ── Pipeline (multi-stage stepper) ─────────────────────────────────────
//
// A horizontal flow of stages: plan → read → edit → verify → reflect.
// The active stage ticks with a braille glyph; done stages are filled
// with a solid dot; upcoming stages are open circles. Designed for
// verbose mode so the user SEES the agent move through the loop.

export interface PipelineStage {
  id: string;
  label: string;
  state: 'done' | 'active' | 'upcoming';
}

export function Pipeline({
  stages,
  activeColor = TEAL,
  doneColor = '#7dd181',
  upcomingColor = '#4a5454',
}: {
  stages: PipelineStage[];
  activeColor?: string;
  doneColor?: string;
  upcomingColor?: string;
}): React.JSX.Element {
  const frame = useTick(110);
  const braille = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  const tick = braille[frame % braille.length]!;

  return (
    <Box>
      {stages.map((s, i) => {
        const color = s.state === 'done' ? doneColor : s.state === 'active' ? activeColor : upcomingColor;
        const glyph = s.state === 'done' ? '●' : s.state === 'active' ? tick : '○';
        const sep =
          i < stages.length - 1
            ? s.state === 'done' && stages[i + 1]!.state === 'done'
              ? '━━━'
              : s.state === 'done'
              ? '━━╸'
              : '╶╶╶'
            : '';
        const sepColor = s.state === 'done' ? doneColor : upcomingColor;
        return (
          <Box key={s.id}>
            <Text color={color}>{glyph}</Text>
            <Text> </Text>
            <Text color={color} bold={s.state === 'active'}>
              {s.label}
            </Text>
            {sep && (
              <Text color={sepColor}> {sep} </Text>
            )}
          </Box>
        );
      })}
    </Box>
  );
}

// ── Reactor (5-line rotating ASCII core) ───────────────────────────────
//
// A small reactor-core spinner with two independent rotating tick rings.
// Used for long ops (compaction, subagent task, verify-retry loops) where
// a single dot feels too quiet.

export function Reactor({ color = TEAL }: { color?: string }): React.JSX.Element {
  const t = useTick(110);
  const ticks = ['╱', '─', '╲', '│'];
  const cores = ['•', '◦', '∙', '·'];
  const tick = (n: number): string => ticks[(t + n) % 4]!;
  const core = cores[t % cores.length]!;
  // Five lines, two-ring layout. Inner core throbs through • → ◦ → ∙ → ·.
  const lines = [
    `  ${tick(0)}     ${tick(2)}`,
    `   ╭─╮ `,
    `${tick(1)}  │${core}│  ${tick(3)}`,
    `   ╰─╯ `,
    `  ${tick(3)}     ${tick(1)}`,
  ];
  return (
    <Box flexDirection="column">
      {lines.map((l, i) => (
        <Text key={i} color={color}>
          {l}
        </Text>
      ))}
    </Box>
  );
}
