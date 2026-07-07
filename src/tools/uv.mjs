import { execSync, execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { detectOS } from '../detect/os.mjs';

function addUvToPath() {
  // After installing uv, update process.env.PATH so subsequent execSync calls find it
  const os = detectOS();
  const uvDir = os === 'windows'
    ? join(homedir(), '.local', 'bin')
    : join(homedir(), '.local', 'bin');
  if (!process.env.PATH?.includes(uvDir)) {
    process.env.PATH = uvDir + (os === 'windows' ? ';' : ':') + (process.env.PATH || '');
  }
}

export async function ensureUv() {
  try {
    execFileSync('uv', ['--version'], { stdio: 'ignore' });
    return { installed: true, alreadyPresent: true };
  } catch {}
  const os = detectOS();
  if (os === 'windows') {
    execSync('powershell -ExecutionPolicy Bypass -c "irm https://astral.sh/uv/install.ps1 | iex"', { stdio: 'inherit' });
  } else {
    execSync('curl -LsSf https://astral.sh/uv/install.sh | sh', { stdio: 'inherit' });
  }
  addUvToPath();
  return { installed: true, alreadyPresent: false };
}

export function uvToolInstall(pkg, extra = []) {
  execSync(`uv tool install ${pkg} ${extra.join(' ')}`, { stdio: 'inherit' });
}

export function uvToolUpgrade(pkg) {
  execSync(`uv tool upgrade ${pkg}`, { stdio: 'inherit' });
}
