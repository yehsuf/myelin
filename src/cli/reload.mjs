import { execSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { detectOS, detectShell } from '../detect/os.mjs';

/**
 * Reload shell profiles in all open terminal windows (best-effort).
 *
 * Strategy per platform:
 *   macOS  — AppleScript tells every Terminal.app + iTerm2 tab to source the profile.
 *   Linux  — Writes a ~/.myelin-reload marker; any shell with the reload hook picks it up.
 *   All    — Prints the manual command as a fallback.
 *
 * Also writes ~/.myelin-reload timestamp so shells can detect a reload is needed.
 */
export async function runReload({ silent = false } = {}) {
  const os   = detectOS();
  const shell = detectShell();
  const home  = homedir();

  const profileMap = {
    zsh:  join(home, '.zshrc'),
    bash: join(home, '.bashrc'),
    fish: join(home, '.config', 'fish', 'config.fish'),
  };
  const shellName = shell.includes('zsh') ? 'zsh'
    : shell.includes('bash') ? 'bash'
    : shell.includes('fish') ? 'fish' : 'sh';

  const profilePath = profileMap[shellName] ?? join(home, '.profile');
  const sourceCmd   = shellName === 'fish'
    ? `source ${profilePath}`
    : `source "${profilePath}"`;

  // Write reload marker with timestamp — shells can check this
  const markerPath = join(home, '.myelin-reload');
  const ts = new Date().toISOString();
  writeFileSync(markerPath, ts, 'utf8');

  // Append a MYELIN_LOADED_AT export to the source command so each terminal
  // gets a visible timestamp after reload
  const sourceCmdWithMarker = shellName === 'fish'
    ? `source ${profilePath}; and set -x MYELIN_LOADED_AT "${ts}"; and echo "✓ myelin profile reloaded at ${ts}"`
    : `source "${profilePath}" && export MYELIN_LOADED_AT="${ts}" && echo "✓ myelin profile reloaded at ${ts}"`;

  let reloaded = false;

  if (os === 'darwin') {
    reloaded = _reloadMacTerminals(sourceCmdWithMarker);
  }

  if (!silent) {
    console.log('\n🔄 Shell profile reload');
    if (reloaded) {
      console.log(`  ✓ Sent reload to all other terminal windows — each will print:`);
      console.log(`      ✓ myelin profile reloaded at ${ts}`);
    } else {
      console.log(`  ⚠ Could not auto-reload other terminals.`);
    }
    // Current shell always needs manual source (child process can't affect parent env)
    console.log(`\n  ▶ Run in THIS terminal:`);
    console.log(`      ${sourceCmd}\n`);
  }

  return reloaded;
}

function _reloadMacTerminals(sourceCmd) {
  let reloaded = false;

  // Terminal.app
  try {
    const script = `tell application "Terminal"
  repeat with w in windows
    repeat with t in tabs of w
      do script "${sourceCmd.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}" in t
    end repeat
  end repeat
end tell`;
    execSync(`osascript << 'APPLESCRIPT'\n${script}\nAPPLESCRIPT`, { stdio: 'pipe', timeout: 5000 });
    reloaded = true;
  } catch {}

  // iTerm2
  try {
    const script = `tell application "iTerm2"
  repeat with w in windows
    repeat with t in tabs of w
      tell current session of t
        write text "${sourceCmd.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"
      end tell
    end repeat
  end repeat
end tell`;
    execSync(`osascript << 'APPLESCRIPT'\n${script}\nAPPLESCRIPT`, { stdio: 'pipe', timeout: 5000 });
    reloaded = true;
  } catch {}

  return reloaded;
}
