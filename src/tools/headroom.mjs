import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { managedPaths, joinManaged, isWindowsStylePath } from '../shared/myelin-paths.mjs';
import { MANAGED_PYTHON_VERSION } from '../update/component-manifest.mjs';

// Pin the classic Python headroom package to a fixed version for reproducible
// installs. Single source of truth referenced by install.mjs and update.mjs so
// the pin can never drift across call sites. HEADROOM_AI_SPEC is a single argv
// element (no shell parsing of the `[all]`/`==` markers).
export const HEADROOM_AI_VERSION = '0.31.0';
export const HEADROOM_AI_SPEC = `headroom-ai[all]==${HEADROOM_AI_VERSION}`;

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

export async function installHeadroom({
  home = homedir(),
  env = process.env,
  execFileSyncImpl = execFileSync,
  mkdirSyncImpl = mkdirSync,
  existsSyncImpl = existsSync,
} = {}) {
  const venv = headroomVenvPath({ home, env });
  mkdirSyncImpl(managedPaths({ home, env }).root, { recursive: true });
  // execFileSync ARGUMENT ARRAYS: the venv path is MYELIN_DIR-derived (arbitrary
  // user text) and must reach `uv` as ONE literal argv element, never composed
  // into a shell string. A relocated root containing `"`, `$(...)`, backticks or
  // `'` therefore cannot break out into command execution.
  execFileSyncImpl('uv', ['venv', '--python', MANAGED_PYTHON_VERSION, venv], { stdio: 'inherit' });
  execFileSyncImpl('uv', ['pip', 'install', '--python', venv, HEADROOM_AI_SPEC], { stdio: 'inherit' });
  const binPath = headroomBinPath({ home, env });
  return { binPath, ok: existsSyncImpl(binPath) };
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
