import { platform, arch as _arch, userInfo } from 'node:os';
import { env } from 'node:process';
import { isWsl } from './wsl.mjs';

export function detectOS(
  detailed = false,
  { platformImpl = platform, archImpl = _arch, isWslImpl = isWsl } = {},
) {
  const p = platformImpl();
  const wsl = p === 'linux' && isWslImpl();
  const os = p === 'darwin' ? 'darwin' : p === 'win32' || wsl ? 'windows' : 'linux';
  if (!detailed) return os;
  return { os, arch: archImpl(), platform: p, wsl };
}

export function powerShellExecutable({
  platformImpl = platform,
  isWslImpl = isWsl,
  windowsInterop = false,
} = {}) {
  if (windowsInterop) return 'powershell.exe';
  const currentPlatform = platformImpl();
  return currentPlatform === 'linux' && isWslImpl() ? 'powershell.exe' : 'powershell';
}

export function detectShell() {
  if (process.platform === 'win32') {
    return env.COMSPEC ?? 'powershell.exe';
  }
  // userInfo().shell reads /etc/passwd — correct even in SSH sessions where
  // $SHELL may be inherited from the client machine (e.g. /bin/zsh on a Mac
  // connecting to a Linux host that uses /bin/bash).
  try {
    const loginShell = userInfo().shell;
    if (loginShell) return loginShell;
  } catch {}
  return env.SHELL ?? '/bin/sh';
}

export function homeDir() {
  return process.env.HOME ?? process.env.USERPROFILE ?? '/tmp';
}
