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
import { homedir, userInfo } from 'node:os';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { bootReplaceLaunchdService } from '../service/launchd.mjs';

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
  // Escape paths for systemd ExecStart: wrap in double-quotes, escape inner quotes/backslashes.
  const esc = (p) => `"${String(p).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  return `[Unit]
Description=myelin messages watcher
After=network.target

[Service]
Type=simple
ExecStart=${esc(nodePath)} ${esc(watcherDst)}
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

/**
 * Install the myelin messages watcher daemon.
 *
 * @param {object} opts
 * @param {string}   [opts.home]        - User home directory
 * @param {string}   [opts.os]          - 'darwin' | 'linux' | 'windows' (detectOS() convention)
 * @param {string}   [opts.nodePath]    - Absolute path to node binary
 * @param {Function} [opts.ok]          - Success logger
 * @param {Function} [opts.warn]        - Warning logger
 * @param {boolean}  [opts.dryRun]      - If true, return plan without writing
 * @param {Function} [opts.execSyncImpl]
 * @param {Function} [opts.existsSyncImpl]
 * @param {Function} [opts.bootReplaceLaunchdImpl]
 * @returns {{ plistPath?: string, plist?: string, unitPath?: string, unit?: string }}
 */
export function installMessagesWatcher({
  home = homedir(),
  os: osName = 'darwin',
  nodePath = process.execPath,
  ok = () => {},
  warn = () => {},
  dryRun = false,
  execSyncImpl = execSync,
  existsSyncImpl = existsSync,
  bootReplaceLaunchdImpl = bootReplaceLaunchdService,
} = {}) {
  const msgDir     = join(home, '.myelin', 'messages');
  const watcherSrc = fileURLToPath(new URL('watcher.mjs', import.meta.url));
  const watcherDst = join(msgDir, 'watcher.mjs');
  const checkScript = join(msgDir, 'check-messages.sh');
  const logFile    = join(msgDir, 'watcher.log');

  if (!dryRun) {
    mkdirSync(msgDir, { recursive: true });

    // Deploy watcher script
    writeFileSync(watcherDst, readFileSync(watcherSrc, 'utf8'));

    // Generate (or update) check-messages.sh
    writeFileSync(checkScript, CHECK_MESSAGES_SH);
    try { chmodSync(checkScript, 0o755); } catch {}
  }

  // Accept both 'darwin' (detectOS() value) and legacy 'mac' spelling
  if (osName === 'darwin' || osName === 'mac') {
    const laDir  = join(home, 'Library', 'LaunchAgents');
    const laFile = join(laDir, `${LABEL}.plist`);
    const plist  = buildLaunchdPlist({ nodePath, watcherDst, logFile, msgDir });

    if (!dryRun) {
      mkdirSync(laDir, { recursive: true });
      writeFileSync(laFile, plist);

      try {
        const uid = userInfo().uid;
        bootReplaceLaunchdImpl({
          uid, label: LABEL, plistPath: laFile, home, execSyncImpl,
        });
        ok('messages watcher started (launchd)');
      } catch (e) {
        warn(`messages watcher plist installed — run: launchctl bootstrap gui/$(id -u) '${laFile}' (${e.message?.split('\n')[0]})`);
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
