import { execFileSync } from 'node:child_process';

/** Fixed observational queries only; no shell, fsmonitor, index refresh or pager. */
export function inspectGit(command: string, cwd: string): string {
  if (!command.startsWith('git ')) throw new Error('Not an inspection git query');
  return execFileSync('git', [
    '--no-optional-locks', '--no-pager', '-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false',
    '-c', 'log.showSignature=false',
    ...command.slice(4).split(' '),
  ], {
    cwd, encoding: 'utf8', timeout: 2_000, maxBuffer: 2 * 1024 * 1024,
    windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'],
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', GIT_NO_LAZY_FETCH: '1' },
  });
}
