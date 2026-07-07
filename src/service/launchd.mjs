import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { execSync } from 'node:child_process';

const LABEL      = 'com.tokenstack.headroom';
const MITM_LABEL = 'com.myelin.mitmproxy';

export function generatePlist({ headroomBin, port, envVars = {}, logPath }) {
  const envEntries = Object.entries(envVars)
    .map(([k, v]) => `        <key>${k}</key>\n        <string>${v}</string>`)
    .join('\n');
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
        <string>${port}</string>
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
    <string>${logPath ?? '/tmp/tokenstack-headroom.log'}</string>
    <key>StandardErrorPath</key>
    <string>${logPath ?? '/tmp/tokenstack-headroom.log'}</string>
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
  // When a corporate proxy is present, chain mitmproxy through it
  const args = ['--listen-port', String(port), '-s', addonPath];
  const proxy = upstreamProxy || envVars.HTTPS_PROXY || envVars.https_proxy || '';
  if (proxy) args.push('--mode', `upstream:${proxy}`);

  const content = generateGenericPlist({
    label: MITM_LABEL,
    command: mitmdumpBin,
    args,
    envVars: {
      MYELIN_HEADROOM_PORT: String(envVars.HEADROOM_PORT ?? 8787),
      ...envVars,
    },
    logPath: logPath ?? join(home ?? homedir(), '.tokenstack', 'mitmproxy.log'),
  });
  mkdirSync(join(homedir(), 'Library', 'LaunchAgents'), { recursive: true });
  writeFileSync(p, content, 'utf8');
  const uid = process.getuid?.() ?? execSync('id -u').toString().trim();
  try { execSync(`launchctl bootout gui/${uid}/${MITM_LABEL}`, { stdio: 'ignore' }); } catch {}
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
  execSync(`launchctl bootstrap gui/${uid} ${p}`);
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
