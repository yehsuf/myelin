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
export async function runReload({
  silent = false,
  os = detectOS(),
  shell = detectShell(),
  home = homedir(),
  execSyncFn = execSync,
  writeFileSyncFn = writeFileSync,
} = {}) {

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
  writeFileSyncFn(markerPath, ts, 'utf8');

  const sourceCmdWithMarker = shellName === 'fish'
    ? `source ${profilePath}`
    : `source "${profilePath}"`;

  let reloaded = false;

  if (os === 'darwin') {
    reloaded = _reloadMacTerminals(sourceCmdWithMarker, execSyncFn);
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

function _reloadMacTerminals(sourceCmd, execSyncFn = execSync) {
  let reloaded = false;
  const cmd = sourceCmd.replace(/\\/g, '\\\\').replace(/"/g, '\\"');

  // The session ID of the terminal running `myelin install` — skip it so we
  // never send a source command into an active AI agent session (Copilot/Claude).
  // TERM_SESSION_ID format: "w0t0p0:XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX"
  // AppleScript `unique id of s` returns only the GUID (no "wNtNpN:" prefix).
  // Strip the prefix so the equality check can actually match.
  const rawSessionId = process.env.TERM_SESSION_ID ?? '';
  const currentSessionGuid = rawSessionId.includes(':') ? rawSessionId.split(':').pop() : rawSessionId;
  const escapedSessionGuid = currentSessionGuid.replace(/\\/g, '\\\\').replace(/"/g, '\\"');

  // Terminal.app — skip tabs that are busy OR contain node (AI agent heuristic).
  // Counting `processes of t` was fragile for idle tabs (login shells report
  // 2+ procs), but checking for "node" specifically is safe: only AI sessions
  // run node as a foreground child of the shell.
  try {
    const script = `if application "Terminal" is running then
tell application "Terminal"
  repeat with w in windows
    repeat with t in tabs of w
      try
        set tabBusy to busy of t
        set tabProcs to processes of t
        set hasNode to false
        repeat with p in tabProcs
          if p contains "node" then set hasNode to true
        end repeat
        if not tabBusy and not hasNode then
          do script "${cmd}" in t
        end if
      end try
    end repeat
  end repeat
end tell
end if`;
    execSyncFn(`osascript << 'APPLESCRIPT'\n${script}\nAPPLESCRIPT`, { stdio: 'pipe', timeout: 5000, killSignal: 'SIGKILL' });
    reloaded = true;
  } catch {}

  // iTerm2 — skip sessions where the foreground job is not the shell itself,
  // AND skip the session whose unique id matches TERM_SESSION_ID (the terminal
  // running myelin install — could be an idle AI session waiting for input).
  // NOTE: `variable named "jobName" of s` (property-of-object form) throws
  // "Access not allowed (-1723)" from a loop-bound reference — must use
  // `tell s ... end tell` form instead.
  try {
    const skipClause = escapedSessionGuid
      ? `if unique id of s is equal to "${escapedSessionGuid}" then\n            -- skip: this is the installer's own terminal session\n          else if jobName contains "node" then\n            -- skip: node child indicates an active AI agent session\n            true\n          else if jobName contains "zsh" or jobName contains "bash" or jobName contains "fish" then\n            tell s to write text "${cmd}"\n          end if`
      : `if jobName contains "node" then\n            -- skip: node child indicates an active AI agent session\n            true\n          else if jobName contains "zsh" or jobName contains "bash" or jobName contains "fish" then\n            tell s to write text "${cmd}"\n          end if`;
    const script = `if application "iTerm2" is running then
tell application "iTerm2"
  repeat with w in windows
    repeat with t in tabs of w
      repeat with s in sessions of t
        try
          tell s
            set jobName to variable named "jobName"
          end tell
          ${skipClause}
        end try
      end repeat
    end repeat
  end repeat
end tell
end if`;
    execSyncFn(`osascript << 'APPLESCRIPT'\n${script}\nAPPLESCRIPT`, { stdio: 'pipe', timeout: 5000, killSignal: 'SIGKILL' });
    reloaded = true;
  } catch {}

  return reloaded;
}
