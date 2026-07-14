import { execFile, execSync, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { existsSync } from 'node:fs';
import { which } from './which.mjs';
import { ensureToolPath } from './tool-path.mjs';
import { getRtkVersionStatus } from '../tools/rtk.mjs';

const execFileP = promisify(execFile);

export async function detectTool(name, versionFlag = '--version') {
  try {
    let path = await which(name);
    if (!path) return { installed: false, version: null, path: null };
    // On Windows, prefer .cmd/.exe over extensionless shim (cmd.exe needs extension when path is quoted)
    if (process.platform === 'win32' && !path.match(/\.(cmd|exe|ps1|bat)$/i)) {
      const cmd = await which(name + '.cmd');
      const exe = await which(name + '.exe');
      path = cmd || exe || path;
    }
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
export async function detectHeadroom({
  headroomBinPathImpl,
  existsSyncImpl = existsSync,
  execFileSyncImpl = execFileSync,
} = {}) {
  // headroom lives in the myelin venv, not in global PATH — check existence + run directly
  const headroomBinPath = headroomBinPathImpl
    ?? (await import('../tools/headroom.mjs')).headroomBinPath;
  const binPath = headroomBinPath();
  if (!existsSyncImpl(binPath)) return { installed: false, version: null, path: null };
  try {
    // execFileSync: binPath (myelin-venv / MYELIN_DIR-derived) is a literal argv[0], never shell-parsed
    const stdout = execFileSyncImpl(binPath, ['--version'], { timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }).toString();
    const version = stdout.trim().split('\n')[0].trim();
    return { installed: true, version, path: binPath };
  } catch {
    return { installed: false, version: null, path: null };
  }
}
export async function detectRtk() {
  const detected = await detectTool('rtk', '--version');
  return { ...detected, ...getRtkVersionStatus(detected.version ?? '') };
}
export async function detectSerena() { return detectTool('serena', '--version'); }
export async function detectCodegraph() { return detectTool('codegraph', '--version'); }
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

export async function detectCopilotHud({
  detectToolImpl = detectTool,
  execSyncImpl = execSync,
  existsSyncImpl = existsSync,
  homeDir = homedir(),
} = {}) {
  try {
    const copilot = await detectToolImpl('copilot', '--version');
    if (!copilot.installed || !copilot.path) return { installed: false, version: null, path: null };
    const stdout = execSyncImpl(`"${copilot.path}" plugin list`, {
      timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'], env: process.env,
    }).toString();
    const pluginLine = stdout.split('\n').find(line => /\bcopilot-hud\b/i.test(line));
    if (!pluginLine) return { installed: false, version: null, path: null };
    const version = pluginLine.match(/\b\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?\b/)?.[0] ?? null;
    const pluginPath = join(homeDir, '.copilot', 'plugins', 'copilot-hud');
    return { installed: true, version, path: existsSyncImpl(pluginPath) ? pluginPath : null };
  } catch {
    return { installed: false, version: null, path: null };
  }
}

export async function detectAll() {
  ensureToolPath();
  const [node, uv, headroom, rtk, serena, semble, astgrep, codegraph] = await Promise.all([
    detectNode(), detectUv(), detectHeadroom(), detectRtk(),
    detectSerena(), detectSemble(), detectAstGrep(), detectCodegraph(),
  ]);
  return { node, uv, headroom, rtk, serena, semble, astgrep, codegraph };
}
