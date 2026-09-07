// Clipboard image → temp PNG, for Ctrl+V in the composer. The terminal pastes
// text itself; only when the clipboard holds an image does a Ctrl+V reach us
// with nothing to paste, so this is the one case to handle. Never throws.

import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface ClipboardImage {
  path: string;
  mediaType: 'image/png';
}

export async function readClipboardImage(): Promise<ClipboardImage | null> {
  const dir = join(tmpdir(), 'autocode-clip');
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    return null;
  }
  const path = join(dir, `clip-${Date.now()}.png`);
  try {
    if (process.platform === 'win32') {
      const script =
        'Add-Type -AssemblyName System.Windows.Forms; ' +
        '$i = [System.Windows.Forms.Clipboard]::GetImage(); ' +
        'if ($i -eq $null) { exit 3 }; ' +
        `$i.Save('${path.replace(/'/g, "''")}', [System.Drawing.Imaging.ImageFormat]::Png); exit 0`;
      await execFileAsync('powershell', ['-NoProfile', '-NonInteractive', '-STA', '-Command', script], {
        timeout: 8000,
        windowsHide: true,
      });
    } else if (process.platform === 'darwin') {
      try {
        await execFileAsync('pngpaste', [path], { timeout: 8000 });
      } catch {
        const osa = `set p to POSIX file "${path}"\nset f to open for access p with write permission\nwrite (the clipboard as «class PNGf») to f\nclose access f`;
        await execFileAsync('osascript', ['-e', osa], { timeout: 8000 });
      }
    } else {
      try {
        await execFileAsync('sh', ['-c', `wl-paste -t image/png > "${path}"`], { timeout: 8000 });
      } catch {
        await execFileAsync('sh', ['-c', `xclip -selection clipboard -t image/png -o > "${path}"`], { timeout: 8000 });
      }
    }
  } catch {
    return null;
  }
  try {
    if (!existsSync(path) || statSync(path).size === 0) return null;
  } catch {
    return null;
  }
  return { path, mediaType: 'image/png' };
}
