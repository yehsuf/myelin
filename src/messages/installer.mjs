/**
 * myelin messages watcher installer
 *
 * Deploys watcher.mjs to ~/.myelin/messages/ and registers it as a
 * persistent daemon (launchd on macOS, systemd on Linux, no-op on Windows).
 * Also generates/updates check-messages.sh with the marker-file approach
 * that the watcher enables.
 *
 * Exported: installMessagesWatcher({ home, os, nodePath, ok, warn, dryRun })
 */
import { mkdirSync, writeFileSync, existsSync, readFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const LABEL = 'com.myelin.messages-watcher';
const SYSTEMD_UNIT = 'myelin-messages-watcher.service';

/** Portable mtime fragment that works on macOS (stat -f) and Linux (stat -c). */
const MTIME_EXPR =
  'CUR=$(stat -f %m "$MSG_FILE" 2>/dev/null || stat -c %Y "$MSG_FILE" 2>/dev/null || echo "0")';

export const CHECK_MESSAGES_SH = `\
#!/usr/bin/env bash
# myelin messages checker — outputs only when new messages exist.
# Uses the fs.watch marker (.new-message) when the watcher daemon is alive;
# falls back to a direct mtime comparison otherwise.
MSG_FILE="$HOME/.myelin/messages/messages.md"
MARKER="$HOME/.myelin/messages/.new-message"
LAST_FILE="$HOME/.myelin/messages/.last-mtime"
PID_FILE="$HOME/.myelin/messages/.watcher-pid"

[[ ! -f "$MSG_FILE" ]] && exit 0

# Determine whether the watcher daemon is alive.
WATCHER_PID=$(cat "$PID_FILE" 2>/dev/null)
if [[ -n "$WATCHER_PID" ]] && kill -0 "$WATCHER_PID" 2>/dev/null; then
  CUR=$(cat "$MARKER" 2>/dev/null || echo "0")
else
  ${MTIME_EXPR}
fi
LAST=$(cat "$LAST_FILE" 2>/dev/null || echo "0")

[[ "$CUR" == "$LAST" ]] && exit 0

# New content — print it.
echo "📬 NEW MESSAGE in ~/.myelin/messages/messages.md:"
echo "────────────────────────────────────────────────────────────────"
cat "$MSG_FILE"
echo "────────────────────────────────────────────────────────────────"

# Mark as seen.
echo "$CUR" > "$LAST_FILE"
`;

function buildLaunchdPlist({ nodePath, watcherDst, logFile, msgDir }) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${LABEL}</string>
    <key>ProgramArguments</key>
    <array>
        <string>${nodePath}</string>
        <string>${watcherDst}</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>ThrottleInterval</key>
    <integer>5</integer>
    <key>StandardOutPath</key>
    <string>${logFile}</string>
    <key>StandardErrorPath</key>
    <string>${logFile}</string>
    <key>WorkingDirectory</key>
    <string>${msgDir}</string>
</dict>
</plist>`;
}

function buildSystemdUnit({ nodePath, watcherDst, logFile, msgDir }) {
  return `[Unit]
Description=myelin messages watcher
After=network.target

[Service]
Type=simple
ExecStart=${nodePath} ${watcherDst}
WorkingDirectory=${msgDir}
StandardOutput=append:${logFile}
StandardError=append:${logFile}
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
`;
}

function readPid(pidFile) {
  try { return parseInt(readFileSync(pidFile, 'utf8').trim(), 10) || null; }
  catch { return null; }
}

function killExistingWatcher(pidFile, execSyncImpl) {
  const pid = readPid(pidFile);
  if (!pid) return;
  try { execSyncImpl(`kill ${pid}`, { stdio: 'ignore' }); } catch {}
}

/**
 * Install the myelin messages watcher daemon.
 *
 * @param {object} opts
 * @param {string}   [opts.home]        - User home directory
 * @param {string}   [opts.os]          - 'mac' | 'linux' | 'windows'
 * @param {string}   [opts.nodePath]    - Absolute path to node binary
 * @param {Function} [opts.ok]          - Success logger
 * @param {Function} [opts.warn]        - Warning logger
 * @param {boolean}  [opts.dryRun]      - If true, return plan without writing
 * @param {Function} [opts.execSyncImpl]
 * @param {Function} [opts.existsSyncImpl]
 * @returns {{ plistPath?: string, plist?: string, unitPath?: string, unit?: string }}
 */
export function installMessagesWatcher({
  home = homedir(),
  os: osName = 'mac',
  nodePath = process.execPath,
  ok = () => {},
  warn = () => {},
  dryRun = false,
  execSyncImpl = execSync,
  existsSyncImpl = existsSync,
} = {}) {
  const msgDir     = join(home, '.myelin', 'messages');
  const watcherSrc = fileURLToPath(new URL('watcher.mjs', import.meta.url));
  const watcherDst = join(msgDir, 'watcher.mjs');
  const checkScript = join(msgDir, 'check-messages.sh');
  const pidFile    = join(msgDir, '.watcher-pid');
  const logFile    = join(msgDir, 'watcher.log');

  if (!dryRun) {
    mkdirSync(msgDir, { recursive: true });

    // Deploy watcher script
    writeFileSync(watcherDst, readFileSync(watcherSrc, 'utf8'));

    // Generate (or update) check-messages.sh
    writeFileSync(checkScript, CHECK_MESSAGES_SH);
    try { chmodSync(checkScript, 0o755); } catch {}
  }

  if (osName === 'mac') {
    const laDir  = join(home, 'Library', 'LaunchAgents');
    const laFile = join(laDir, `${LABEL}.plist`);
    const plist  = buildLaunchdPlist({ nodePath, watcherDst, logFile, msgDir });

    if (!dryRun) {
      mkdirSync(laDir, { recursive: true });
      killExistingWatcher(pidFile, execSyncImpl);

      // Unload any stale registration before (re)writing the plist
      try {
        execSyncImpl(`launchctl bootout gui/$(id -u)/${LABEL} 2>/dev/null || true`,
          { shell: true, stdio: 'pipe' });
      } catch {}

      writeFileSync(laFile, plist);

      try {
        execSyncImpl(`launchctl bootstrap gui/$(id -u) '${laFile}'`,
          { shell: true, stdio: 'pipe' });
        ok('messages watcher started (launchd)');
      } catch {
        warn(`messages watcher plist installed — run: launchctl bootstrap gui/$(id -u) '${laFile}'`);
      }
    }

    return { plistPath: laFile, plist };
  }

  if (osName === 'linux') {
    const unitDir  = join(home, '.config', 'systemd', 'user');
    const unitPath = join(unitDir, SYSTEMD_UNIT);
    const unit     = buildSystemdUnit({ nodePath, watcherDst, logFile, msgDir });

    if (!dryRun) {
      mkdirSync(unitDir, { recursive: true });
      killExistingWatcher(pidFile, execSyncImpl);
      writeFileSync(unitPath, unit);

      try {
        execSyncImpl('systemctl --user daemon-reload', { stdio: 'pipe' });
        execSyncImpl(`systemctl --user enable --now ${SYSTEMD_UNIT}`, { stdio: 'pipe' });
        ok('messages watcher started (systemd)');
      } catch {
        warn(`messages watcher unit installed — run: systemctl --user enable --now ${SYSTEMD_UNIT}`);
      }
    }

    return { unitPath, unit };
  }

  // Windows: deploy scripts only — no persistent daemon (launchd/systemd unavailable)
  if (!dryRun) ok('messages watcher scripts installed (Windows: start manually with node ~/.myelin/messages/watcher.mjs)');
  return {};
}

export { LABEL as MESSAGES_WATCHER_LABEL, SYSTEMD_UNIT as MESSAGES_WATCHER_UNIT };
