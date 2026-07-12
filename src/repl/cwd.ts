import { existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';

export interface CwdStatus {
  ok: boolean;
  label: string;
}

export function cleanCwdArg(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length < 2) return trimmed;
  const first = trimmed[0];
  const last = trimmed[trimmed.length - 1];
  if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

export function resolveCwdTarget(raw: string, currentRoot: string): string {
  const arg = expandHome(cleanCwdArg(raw));
  if (arg.length === 0) return currentRoot;
  return resolve(currentRoot, arg);
}

export function cwdStatus(target: string): CwdStatus {
  if (!existsSync(target)) return { ok: false, label: 'not found' };
  try {
    if (!statSync(target).isDirectory()) return { ok: false, label: 'not a directory' };
  } catch {
    return { ok: false, label: 'not readable' };
  }
  return { ok: true, label: 'directory' };
}

function expandHome(arg: string): string {
  if (arg === '~') return homedir();
  if (arg.startsWith('~/') || arg.startsWith('~\\')) {
    return resolve(homedir(), arg.slice(2));
  }
  return arg;
}
