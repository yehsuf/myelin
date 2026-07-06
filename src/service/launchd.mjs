import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { execSync } from 'node:child_process';

const LABEL = 'com.tokenstack.headroom';

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
    const out = execSync(`launchctl list ${LABEL} 2>&1`).toString();
    return { running: !out.includes('Could not find service'), raw: out };
  } catch {
    return { running: false, raw: '' };
  }
}
