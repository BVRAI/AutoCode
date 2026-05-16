import { homedir, platform } from 'node:os';
import { join, resolve } from 'node:path';

export function dataDir(): string {
  const override = process.env.AUTOCODE_DATA_DIR;
  if (override && override.trim().length > 0) {
    return resolve(override);
  }
  if (platform() === 'win32') {
    const localAppData = process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local');
    return join(localAppData, 'autocode');
  }
  const xdg = process.env.XDG_DATA_HOME;
  if (xdg && xdg.trim().length > 0) {
    return join(xdg, 'autocode');
  }
  return join(homedir(), '.local', 'share', 'autocode');
}

export function configDir(): string {
  return join(homedir(), '.autocode');
}

export function sessionsDir(): string {
  return join(dataDir(), 'sessions');
}

export function projectRootDefault(): string {
  const override = process.env.AUTOCODE_PROJECT_ROOT;
  if (override && override.trim().length > 0) {
    return resolve(override);
  }
  return process.cwd();
}
