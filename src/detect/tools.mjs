import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { which } from './which.mjs';

const execFileP = promisify(execFile);

export async function detectTool(name, versionFlag = '--version') {
  try {
    const path = await which(name);
    if (!path) return { installed: false, version: null, path: null };
    // Prefer .cmd path on Windows (npm shims) — execFile can run those directly
    const resolvedPath = process.platform === 'win32' && !path.match(/\.(cmd|exe|ps1)$/i)
      ? (await which(name + '.cmd') || path)
      : path;
    const { stdout } = await execFileP(resolvedPath, [versionFlag], {
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const version = stdout.trim().split('\n')[0].trim();
    return { installed: true, version, path };
  } catch {
    return { installed: false, version: null, path: null };
  }
}

export async function detectUv() { return detectTool('uv', '--version'); }
export async function detectNode() { return detectTool('node', '--version'); }
export async function detectHeadroom() { return detectTool('headroom', '--version'); }
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
  const [node, uv, headroom, rtk, serena, semble, astgrep] = await Promise.all([
    detectNode(), detectUv(), detectHeadroom(), detectRtk(),
    detectSerena(), detectSemble(), detectAstGrep(),
  ]);
  return { node, uv, headroom, rtk, serena, semble, astgrep };
}
