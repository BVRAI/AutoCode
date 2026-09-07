// Killing a shell-spawned command must take its whole tree with it. On
// Windows `child.kill()` ends cmd.exe and leaves the program it started
// alive, holding the stdout/stderr pipes — so the spawner's 'close' event
// never fires and a timed-out tool call waits forever (the Phase 5 Aider
// battery lost two 900-second tasks to exactly this). `taskkill /T /F`
// walks the tree; on POSIX the command runs in its own process group and
// the group is signalled.

import { execFile, type ChildProcess } from 'node:child_process';

export function spawnOptionsForTree(): { detached: boolean } {
  return { detached: process.platform !== 'win32' };
}

/** Kill `child` and every descendant. Never throws. */
export function killTree(child: ChildProcess): void {
  const pid = child.pid;
  if (!pid) return;
  if (process.platform === 'win32') {
    execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: 5_000 }, () => {
      // taskkill may already have finished the job or the process may be gone; either way, belt and braces.
      try {
        child.kill('SIGKILL');
      } catch {
        /* already dead */
      }
    });
    return;
  }
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    try {
      child.kill('SIGKILL');
    } catch {
      /* already dead */
    }
  }
}
