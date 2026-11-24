// The only OS-aware module in the backend.
//
// Default locations and service conventions differ per platform; everything
// else in the tree uses node:path and argv arrays and must not branch on
// process.platform.

import { homedir } from 'node:os';
import { join } from 'node:path';

export const IS_WINDOWS = process.platform === 'win32';
export const IS_MACOS = process.platform === 'darwin';

export function defaultConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  if (IS_WINDOWS) return join(env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'rfmail');
  if (IS_MACOS) return join(homedir(), 'Library', 'Preferences', 'rfmail');
  const xdg = env.XDG_CONFIG_HOME;
  return xdg ? join(xdg, 'rfmail') : join(homedir(), '.config', 'rfmail');
}

export function defaultDataDir(env: NodeJS.ProcessEnv = process.env): string {
  if (IS_WINDOWS) return join(env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'rfmail');
  if (IS_MACOS) return join(homedir(), 'Library', 'Application Support', 'rfmail');
  const xdg = env.XDG_DATA_HOME;
  return xdg ? join(xdg, 'rfmail') : join(homedir(), '.local', 'share', 'rfmail');
}

export function defaultConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(defaultConfigDir(env), 'rfmail.toml');
}
