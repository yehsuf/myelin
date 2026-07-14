import { homedir } from 'node:os';
import { managedPaths, pathModuleForPlatform } from '../shared/myelin-paths.mjs';

/**
 * Prepend Myelin's tool directories to process.env.PATH so tool DETECTION
 * (detectTool/detectRtk) and subsequent tool invocations find binaries that are
 * installed but not on the *inherited* PATH.
 *
 * This is the common case for a non-interactive install driven over ssh: the
 * login-shell PATH (from .bashrc/.zshrc) includes ~/.myelin/bin and ~/.local/bin,
 * but the minimal PATH this process inherits does not. Previously the logic was
 * Windows-only, so ssh-driven Linux/macOS installs silently failed to detect rtk
 * (installed in ~/.myelin/bin) and never wired its Copilot hook.
 *
 * Uses the OS-correct path delimiter (`:` on POSIX, `;` on Windows) and is
 * idempotent — safe to call repeatedly.
 */
export function ensureToolPath({ home = homedir(), platform = process.platform, env = process.env } = {}) {
  const { join } = pathModuleForPlatform(platform);
  const dirs = [
    join(home, '.local', 'bin'),
    managedPaths({ home, env, platform }).binDir,
  ];
  if (platform === 'win32') {
    dirs.push(
      join(home, 'AppData', 'Roaming', 'uv', 'bin'),
      join(home, 'AppData', 'Local', 'uv', 'bin'),
      join(home, 'AppData', 'Roaming', 'npm'),
      join(home, 'AppData', 'Local', 'npm'),
      ...[...Array(8)].map((_, i) => join(home, 'AppData', 'Roaming', 'Python', `Python3${10 + i}`, 'Scripts')),
      ...[...Array(8)].map((_, i) => join(home, 'AppData', 'Local', 'Programs', 'Python', `Python3${10 + i}`, 'Scripts')),
    );
    const nvmDir = env.NVM_HOME || env.NVM_SYMLINK;
    if (nvmDir) dirs.push(nvmDir);
    if (env.NVM4W_HOME) dirs.push(join(env.NVM4W_HOME, 'nodejs'));
    dirs.push(join(process.execPath, '..')); // node.exe's own dir (nvm4w / portable)
  }
  const delim = platform === 'win32' ? ';' : ':';
  const seen = new Set((env.PATH || '').split(delim).filter(Boolean));
  for (const p of dirs) {
    if (!seen.has(p)) {
      env.PATH = p + delim + (env.PATH || '');
      seen.add(p);
    }
  }
  return env.PATH;
}
