import { execFile, execSync } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { which } from './which.mjs';

const execFileP = promisify(execFile);

function ensureWindowsPath() {
  if (process.platform !== 'win32') return;
  const home = homedir();
  const extra = [
    join(home, '.local', 'bin'),
    join(home, '.tokenstack', 'bin'),
    join(home, 'AppData', 'Roaming', 'uv', 'bin'),
    join(home, 'AppData', 'Local', 'uv', 'bin'),
    join(home, 'AppData', 'Roaming', 'npm'),
    join(process.execPath, '..'), // nvm4w / portable node bin dir
    ...[...Array(8)].map((_, i) => join(home, 'AppData', 'Roaming', 'Python', `Python3${10+i}`, 'Scripts')),
    ...[...Array(8)].map((_, i) => join(home, 'AppData', 'Local', 'Programs', 'Python', `Python3${10+i}`, 'Scripts')),
  ];
  for (const p of extra) {
    if (!process.env.PATH?.includes(p)) process.env.PATH = p + ';' + (process.env.PATH || '');
  }
}

export async function detectTool(name, versionFlag = '--version') {
  try {
    const path = await which(name);
    if (!path) return { installed: false, version: null, path: null };
    // execSync with string avoids DEP0190 and runs .cmd shims correctly on Windows
    const stdout = execSync(`"${path}" ${versionFlag}`, {
      timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'], env: process.env,
    }).toString();
    const version = stdout.trim().split('\n')[0].trim();
    return { installed: true, version, path };
  } catch {
    return { installed: false, version: null, path: null };
  }
}

export async function detectUv() { return detectTool('uv', '--version'); }
export async function detectNode() { return detectTool('node', '--version'); }
export async function detectHeadroom() {
  // headroom lives in the myelin venv, not in global PATH — check existence + run directly
  const { headroomBinPath } = await import('../tools/headroom.mjs');
  const { existsSync } = await import('node:fs');
  const binPath = headroomBinPath();
  if (!existsSync(binPath)) return { installed: false, version: null, path: null };
  try {
    const { execSync } = await import('node:child_process');
    const stdout = execSync(`"${binPath}" --version`, { timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }).toString();
    const version = stdout.trim().split('\n')[0].trim();
    return { installed: true, version, path: binPath };
  } catch {
    return { installed: false, version: null, path: null };
  }
}
export async function detectRtk() { return detectTool('rtk', '--version'); }
export async function detectSerena() { return detectTool('serena', '--version'); }
export async function detectSemble() {
  // semble uses subcommands, no --version flag
  const path = await which('semble');
  if (!path) return { installed: false, version: null, path: null };
  return { installed: true, version: 'semble (installed)', path };
}
export async function detectAstGrep() {
  // @ast-grep/cli installs as 'sg' on all platforms; 'ast-grep' is the Rust crate name
  return (await detectTool('ast-grep', '--version')).installed
    ? detectTool('ast-grep', '--version')
    : detectTool('sg', '--version');
}

export async function detectAll() {
  ensureWindowsPath();
  const [node, uv, headroom, rtk, serena, semble, astgrep] = await Promise.all([
    detectNode(), detectUv(), detectHeadroom(), detectRtk(),
    detectSerena(), detectSemble(), detectAstGrep(),
  ]);
  return { node, uv, headroom, rtk, serena, semble, astgrep };
}
