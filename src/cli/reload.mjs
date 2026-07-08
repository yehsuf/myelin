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

  const profilePath = os === 'windows'
    ? join(process.env.APPDATA || join(home, 'AppData', 'Roaming'), 'Microsoft', 'Windows', 'PowerShell', 'v1.0', 'profile.ps1')
    : (profileMap[shellName] ?? join(home, '.profile'));
  const sourceCmd = os === 'windows'
    ? `. "${profilePath}"`
    : (shellName === 'fish' ? `source ${profilePath}` : `source "${profilePath}"`);

  // Write reload marker with timestamp — shells can check this
  const markerPath = join(home, '.myelin-reload');
  const ts = new Date().toISOString();
  writeFileSync(markerPath, ts, 'utf8');

  const sourceCmdWithMarker = shellName === 'fish'
    ? `source ${profilePath}`
    : `source "${profilePath}"`;

  let reloaded = false;

  if (os === 'darwin') {
    reloaded = _reloadMacTerminals(sourceCmdWithMarker);
  }

  if (!silent) {
    console.log('\n🔄 Shell profile reload');
    if (reloaded) {
      console.log(`  ✓ Reloaded all open terminal windows`);
    } else {
      console.log(`  ⚠ Could not auto-reload. Run manually:\n      ${sourceCmd}`);
    }
    console.log();
  }

  return reloaded;
}

function _reloadMacTerminals(sourceCmd) {
  let reloaded = false;
  const cmd = sourceCmd.replace(/\\/g, '\\\\').replace(/"/g, '\\"');

  // Terminal.app — use the tab's own "busy" property (true while a foreground
  // command is running). This is the reliable idle signal; counting
  // `processes of t` is fragile (login shells often report 2+ processes,
  // e.g. {"login", "-zsh"}, even while completely idle) and was causing
  // reload to skip nearly every idle tab.
  try {
    const script = `tell application "Terminal"
  repeat with w in windows
    repeat with t in tabs of w
      try
        if not busy of t then
          do script "${cmd}" in t
        end if
      end try
    end repeat
  end repeat
end tell`;
    execSync(`osascript << 'APPLESCRIPT'\n${script}\nAPPLESCRIPT`, { stdio: 'pipe', timeout: 5000 });
    reloaded = true;
  } catch {}

  // iTerm2 — only sessions where the foreground job is the shell itself.
  // NOTE: `variable named "jobName" of s` (property-of-object form) throws
  // "Access not allowed (-1723)" whenever `s` is a loop-bound reference from
  // `repeat with s in sessions of t` — verified live against real iTerm2
  // sessions. Must use `tell s ... end tell` instead; that form works
  // reliably. The previous code used an even more broken variant
  // (`variable value of s named ...`), which threw on every run and
  // aborted the whole tell-block, so nothing in iTerm2 ever got reloaded.
  try {
    const script = `tell application "iTerm2"
  repeat with w in windows
    repeat with t in tabs of w
      repeat with s in sessions of t
        try
          tell s
            set jobName to variable named "jobName"
          end tell
          if jobName contains "zsh" or jobName contains "bash" or jobName contains "fish" then
            tell s to write text "${cmd}"
          end if
        end try
      end repeat
    end repeat
  end repeat
end tell`;
    execSync(`osascript << 'APPLESCRIPT'\n${script}\nAPPLESCRIPT`, { stdio: 'pipe', timeout: 5000 });
    reloaded = true;
  } catch {}

  return reloaded;
}
