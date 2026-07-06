import { platform, arch as _arch } from 'node:os';
import { env } from 'node:process';

export function detectOS(detailed = false) {
  const p = platform();
  const os = p === 'darwin' ? 'darwin' : p === 'win32' ? 'windows' : 'linux';
  if (!detailed) return os;
  return { os, arch: _arch(), platform: p };
}

export function detectShell() {
  if (process.platform === 'win32') {
    return env.COMSPEC ?? 'powershell.exe';
  }
  return env.SHELL ?? '/bin/sh';
}

export function homeDir() {
  return process.env.HOME ?? process.env.USERPROFILE ?? '/tmp';
}
