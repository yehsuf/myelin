import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { execSync } from 'node:child_process';

const LABEL      = 'com.myelin.headroom';
const MITM_LABEL = 'com.myelin.mitmproxy';
const WATCHDOG_LABEL = 'com.myelin.watchdog';

export function generatePlist({ headroomBin, port, envVars = {}, logPath, interceptToolResults }) {
  const envEntries = Object.entries(envVars)
    .map(([k, v]) => `        <key>${k}</key>\n        <string>${v}</string>`)
    .join('\n');
  const extraArgs = interceptToolResults
    ? '\n        <string>--intercept-tool-results</string>'
    : '';
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${LABEL}</string>
    <key>ProgramArguments</key>
    <array>
        <string>${headroomBin}</string>
        <string>proxy</string>
        <string>--port</string>
        <string>${port}</string>${extraArgs}
    </array>
    <key>EnvironmentVariables</key>
    <dict>
${envEntries}
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>ThrottleInterval</key>
    <integer>10</integer>
    <key>StandardOutPath</key>
    <string>${logPath ?? '/tmp/myelin-headroom.log'}</string>
    <key>StandardErrorPath</key>
    <string>${logPath ?? '/tmp/myelin-headroom.log'}</string>
</dict>
</plist>`;
}

export function plistPath() {
  return join(homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);
}

export function mitmPlistPath() {
  return join(homedir(), 'Library', 'LaunchAgents', `${MITM_LABEL}.plist`);
}

/** Generic plist generator — use for any long-running LaunchAgent. */
export function generateGenericPlist({ label, command, args = [], envVars = {}, logPath }) {
  const envEntries = Object.entries(envVars)
    .map(([k, v]) => `        <key>${k}</key>\n        <string>${v}</string>`)
    .join('\n');
  const argItems = [command, ...args]
    .map(a => `        <string>${a}</string>`)
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${label}</string>
    <key>ProgramArguments</key>
    <array>
${argItems}
    </array>
    <key>EnvironmentVariables</key>
    <dict>
${envEntries}
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>ThrottleInterval</key>
    <integer>10</integer>
    <key>StandardOutPath</key>
    <string>${logPath ?? '/tmp/myelin.log'}</string>
    <key>StandardErrorPath</key>
    <string>${logPath ?? '/tmp/myelin.log'}</string>
</dict>
</plist>`;
}

/** Install mitmproxy as a LaunchAgent running the Myelin addon.
 *  If an enterprise upstream proxy is set (via envVars.HTTPS_PROXY),
 *  mitmproxy is started in upstream mode so it chains through it.
 */
export function installMitmService({ mitmdumpBin, port, addonPath, envVars = {}, logPath, home, upstreamProxy }) {
  const p = mitmPlistPath();
  const args = ['--listen-port', String(port), '-s', addonPath];

  // Chain through corporate/upstream proxy if set
  const proxy = upstreamProxy || envVars.HTTPS_PROXY || envVars.https_proxy || '';
  // Never route mitmproxy through itself — skip 127.0.0.1 upstream
  if (proxy && !proxy.includes('127.0.0.1') && !proxy.includes('localhost')) args.push('--mode', `upstream:${proxy}`);

  // Pass our CA bundle to mitmproxy's upstream TLS verifier.
  // Required when a corporate SSL interceptor (MITM proxy) sits between
  // this machine and the internet — mitmproxy must trust its CA to connect upstream.
  const caBundle = envVars.SSL_CERT_FILE || envVars.REQUESTS_CA_BUNDLE ||
                   envVars.NODE_EXTRA_CA_CERTS || envVars.HEADROOM_CA_BUNDLE || '';
  if (caBundle) args.push('--set', `ssl_verify_upstream_trusted_ca=${caBundle}`);

  // Bypass TLS interception for mTLS hosts (Akamai internal tools, etc.)
  // client certs cannot survive CONNECT proxy — these get raw TCP tunnel
  const IGNORE_HOSTS = [
    String.raw`.*\.akamai\.com`,
    String.raw`.*\.corp\.akamai\.com`,
    String.raw`.*\.akamaized\.net`,
    String.raw`.*\.akamaihd\.net`,
    String.raw`api\.github\.com`,
    String.raw`.*\.githubcopilot\.com`,
    String.raw`.*\.github\.com`,
  ].join('|');
  args.push('--ignore-hosts', IGNORE_HOSTS);

  const content = generateGenericPlist({
    label: MITM_LABEL,
    command: mitmdumpBin,
    args,
    envVars: {
      MYELIN_HEADROOM_PORT: String(envVars.HEADROOM_PORT ?? 8787),
      ...envVars,
    },
    logPath: logPath ?? join(home ?? homedir(), '.myelin', 'mitmproxy.log'),
  });
  mkdirSync(join(homedir(), 'Library', 'LaunchAgents'), { recursive: true });
  writeFileSync(p, content, 'utf8');
  const uid = process.getuid?.() ?? execSync('id -u').toString().trim();
  try { execSync(`launchctl bootout gui/${uid}/${MITM_LABEL}`, { stdio: 'ignore' }); } catch {}
  execSync('sleep 1');
  execSync(`launchctl bootstrap gui/${uid} ${p}`);
}

export function mitmServiceStatus() {
  try {
    const out = execSync(`launchctl list ${MITM_LABEL} 2>&1`).toString();
    return { running: !out.includes('Could not find service'), label: MITM_LABEL, raw: out };
  } catch {
    return { running: false, raw: '' };
  }
}

export function installService(opts) {
  const content = generatePlist(opts);
  const p = plistPath();
  mkdirSync(join(homedir(), 'Library', 'LaunchAgents'), { recursive: true });
  writeFileSync(p, content, 'utf8');
  const uid = process.getuid?.() ?? execSync('id -u').toString().trim();
  try { execSync(`launchctl bootout gui/${uid}/${LABEL}`, { stdio: 'ignore' }); } catch {}
  execSync('sleep 1');
  execSync(`launchctl bootstrap gui/${uid} ${p}`);
}

/**
 * Install a watchdog LaunchAgent that periodically checks headroom + mitmproxy
 * ports and re-bootstraps any service that's down.
 *
 * Why this exists: macOS launchd applies crash-loop protection to KeepAlive
 * jobs — after repeated fast exits, it can silently stop trying to relaunch
 * the job (no error, no log entry) until it's explicitly re-bootstrapped.
 * `myelin restart`/reinstall recovers it, but nothing catches this
 * automatically otherwise, so Copilot/Claude requests fail with ECONNREFUSED
 * until a human notices and intervenes. This watchdog closes that gap.
 */
export function installWatchdog({ home, headroomPort = 8787, mitmPort = 8888 } = {}) {
  home = home ?? homedir();
  const binDir = join(home, '.myelin', 'bin');
  mkdirSync(binDir, { recursive: true });
  const scriptPath = join(binDir, 'watchdog.sh');
  const la = join(home, 'Library', 'LaunchAgents');
  const watchdogLog = join(home, '.myelin', 'watchdog.log');

  const script = `#!/usr/bin/env bash
# Myelin watchdog — re-bootstraps headroom/mitmproxy if launchd silently dropped them.
set -uo pipefail
UID_N=$(id -u)
LA="${la}"

check_and_revive() {
  local port="$1" name="$2" glob="$3"
  if nc -z 127.0.0.1 "$port" 2>/dev/null; then return 0; fi
  local plist
  plist=$(ls "$LA"/$glob 2>/dev/null | grep -v '\\.bak' | head -1)
  if [ -z "$plist" ]; then return 0; fi
  local label
  label=$(basename "$plist" .plist)
  launchctl bootout "gui/$UID_N/$label" 2>/dev/null
  sleep 1
  launchctl bootstrap "gui/$UID_N" "$plist" 2>/dev/null
  echo "[watchdog] $(date '+%Y-%m-%d %H:%M:%S') revived $name ($label)" >> "${watchdogLog}"
}

check_and_revive ${mitmPort} mitmproxy '*.mitmproxy.plist'
check_and_revive ${headroomPort} headroom '*.headroom.plist'
`;
  writeFileSync(scriptPath, script, 'utf8');
  execSync(`chmod +x "${scriptPath}"`);

  const plistContent = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${WATCHDOG_LABEL}</string>
    <key>ProgramArguments</key>
    <array>
        <string>/bin/bash</string>
        <string>${scriptPath}</string>
    </array>
    <key>StartInterval</key>
    <integer>90</integer>
    <key>RunAtLoad</key>
    <true/>
    <key>StandardOutPath</key>
    <string>${watchdogLog}</string>
    <key>StandardErrorPath</key>
    <string>${watchdogLog}</string>
</dict>
</plist>`;
  const plistPathW = join(la, `${WATCHDOG_LABEL}.plist`);
  mkdirSync(la, { recursive: true });
  writeFileSync(plistPathW, plistContent, 'utf8');
  const uid = process.getuid?.() ?? execSync('id -u').toString().trim();
  try { execSync(`launchctl bootout gui/${uid}/${WATCHDOG_LABEL}`, { stdio: 'ignore' }); } catch {}
  execSync('sleep 1');
  execSync(`launchctl bootstrap gui/${uid} ${plistPathW}`);
  return plistPathW;
}

export function serviceStatus() {
  try {
    // Check our canonical label first
    const labels = [
      LABEL,
      // Username-variant: com.<username>.headroom (common pattern in manual setups)
      `com.${process.env.USER || process.env.USERNAME || ''}.headroom`,
    ].filter((l, i, a) => l !== LABEL || i === 0 ? true : a.indexOf(l) === i); // dedupe

    for (const label of labels) {
      try {
        const out = execSync(`launchctl list ${label} 2>&1`).toString();
        if (!out.includes('Could not find service')) {
          return { running: true, label, raw: out };
        }
      } catch {}
    }

    // Fallback: scan all loaded agents for anything headroom-related
    try {
      const all = execSync('launchctl list 2>&1').toString();
      const match = all.split('\n').find(l => l.toLowerCase().includes('headroom'));
      if (match) {
        const label = match.trim().split(/\s+/).pop();
        return { running: true, label, raw: match };
      }
    } catch {}

    return { running: false, raw: '' };
  } catch {
    return { running: false, raw: '' };
  }
}
