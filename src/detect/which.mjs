import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const execFileP = promisify(execFile);

export async function which(name) {
  try {
    const cmd = process.platform === 'win32' ? 'where' : 'which';
    const { stdout } = await execFileP(cmd, [name], { timeout: 3000 });
    return stdout.trim().split('\n')[0];
  } catch {
    return null;
  }
}
