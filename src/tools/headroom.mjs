import { execSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { managedPaths, joinManaged, isWindowsStylePath } from '../shared/myelin-paths.mjs';

export function parseHeadroomVersion(raw = '') {
  const m = raw.match(/(\d+\.\d+\.\d+)/);
  return m ? m[1] : null;
}

export function headroomHealthUrl(port = 8787) {
  return `http://127.0.0.1:${port}/health`;
}

export function headroomVenvPath({ home = homedir(), env = process.env } = {}) {
  return managedPaths({ home, env }).venvPath;
}

export function headroomBinPath({ home = homedir(), env = process.env } = {}) {
  const venv = headroomVenvPath({ home, env });
  // The venv layout (Windows `Scripts/*.exe` vs POSIX `bin/*`) follows the
  // managed root's OWN path style, not the host `process.platform`: a relocated
  // Windows-style MYELIN_DIR resolved on a POSIX host still describes a Windows
  // venv, and a POSIX root on a Windows host still describes a POSIX venv.
  // Extend it with joinManaged so separators match the root end to end instead
  // of splicing host-native separators onto a cross-style relocated root.
  return isWindowsStylePath(venv)
    ? joinManaged(venv, 'Scripts', 'headroom.exe')
    : joinManaged(venv, 'bin', 'headroom');
}

export async function installHeadroom({ home = homedir(), env = process.env } = {}) {
  const venv = headroomVenvPath({ home, env });
  mkdirSync(managedPaths({ home, env }).root, { recursive: true });
  execSync(`uv venv ${venv}`, { stdio: 'inherit' });
  execSync(`uv pip install --python ${venv} "headroom-ai[all]"`, { stdio: 'inherit' });
  const binPath = headroomBinPath({ home, env });
  return { binPath, ok: existsSync(binPath) };
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
