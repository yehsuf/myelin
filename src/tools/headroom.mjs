import { execSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

export function parseHeadroomVersion(raw = '') {
  const m = raw.match(/(\d+\.\d+\.\d+)/);
  return m ? m[1] : null;
}

export function headroomHealthUrl(port = 8787) {
  return `http://127.0.0.1:${port}/health`;
}

export function headroomVenvPath() {
  return join(homedir(), '.tokenstack', 'venv');
}

export function headroomBinPath() {
  const venv = headroomVenvPath();
  const isWin = process.platform === 'win32';
  return isWin
    ? join(venv, 'Scripts', 'headroom.exe')
    : join(venv, 'bin', 'headroom');
}

export async function installHeadroom() {
  const venv = headroomVenvPath();
  mkdirSync(join(homedir(), '.tokenstack'), { recursive: true });
  execSync(`uv venv ${venv}`, { stdio: 'inherit' });
  execSync(`uv pip install --python ${venv} "headroom-ai[all]"`, { stdio: 'inherit' });
  return { binPath: headroomBinPath(), ok: existsSync(headroomBinPath()) };
}

export async function waitForHeadroom(port = 8787, timeoutMs = 5000) {
  const url = headroomHealthUrl(port);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(500) });
      if (res.ok) return true;
    } catch {}
    await new Promise(r => setTimeout(r, 100));
  }
  return false;
}
