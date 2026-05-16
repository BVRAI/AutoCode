import { HARD_BLOCK, SOFT_CONFIRM, type SafetyPattern } from './patterns.js';

export type SafetyVerdict =
  | { kind: 'allow' }
  | { kind: 'confirm'; reason: string; pattern: string }
  | { kind: 'block'; reason: string; pattern: string };

export function classifyCommand(command: string): SafetyVerdict {
  const trimmed = command.trim();
  if (trimmed.length === 0) return { kind: 'allow' };

  const hard = firstMatch(trimmed, HARD_BLOCK);
  if (hard) return { kind: 'block', reason: hard.reason, pattern: hard.re.source };

  const soft = firstMatch(trimmed, SOFT_CONFIRM);
  if (soft) return { kind: 'confirm', reason: soft.reason, pattern: soft.re.source };

  return { kind: 'allow' };
}

function firstMatch(command: string, patterns: SafetyPattern[]): SafetyPattern | undefined {
  for (const p of patterns) {
    if (p.re.test(command)) return p;
  }
  return undefined;
}
