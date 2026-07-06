import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { which } from './which.mjs';

const execFileP = promisify(execFile);

export async function detectTool(name, versionFlag = '--version') {
  try {
    const path = await which(name);
    if (!path) return { installed: false, version: null, path: null };
    const { stdout } = await execFileP(name, [versionFlag], { timeout: 5000 });
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
export async function detectSemble() { return detectTool('semble', '--version'); }
export async function detectAstGrep() { return detectTool('ast-grep', '--version'); }

export async function detectAll() {
  const [node, uv, headroom, rtk, serena, semble, astgrep] = await Promise.all([
    detectNode(), detectUv(), detectHeadroom(), detectRtk(),
    detectSerena(), detectSemble(), detectAstGrep(),
  ]);
  return { node, uv, headroom, rtk, serena, semble, astgrep };
}
