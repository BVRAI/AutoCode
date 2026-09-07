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
  // A child that already exited must not be killed by pid: Windows reuses
  // pids within seconds, and `taskkill /T` on a stale one takes down whatever
  // unrelated process (another harness, a test runner) inherited the number.
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'win32') {
    // Not `taskkill /T`: it treats every process whose ParentProcessId equals
    // the target as a child, and an orphan keeps the pid of a parent that died,
    // so a recycled pid makes it kill strangers (a benchmark harness lost
    // tasks to exactly that). Walk the tree ourselves and only accept a child
    // created after its parent.
    const script = [
      `$root = ${pid}`,
      '$all = Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId, CreationDate',
      '$byId = @{}; foreach ($p in $all) { $byId[[int]$p.ProcessId] = $p }',
      'function Kill-Tree([int]$id) {',
      '  $me = $byId[$id]; if ($null -eq $me) { return }',
      '  foreach ($k in $all) { if ([int]$k.ParentProcessId -eq $id -and [int]$k.ProcessId -ne $id -and $k.CreationDate -ge $me.CreationDate) { Kill-Tree ([int]$k.ProcessId) } }',
      '  try { Stop-Process -Id $id -Force -ErrorAction Stop } catch {}',
      '}',
      'Kill-Tree $root',
    ].join('; ');
    execFile('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], { windowsHide: true, timeout: 15_000 }, () => {
      // Whatever the walk managed, the direct child must not survive.
      try {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
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
