import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { execSync } from 'node:child_process';

export function generateSystemdUnit({ headroomBin, port, envVars = {} }) {
  const envLines = Object.entries(envVars).map(([k, v]) => `Environment=${k}=${v}`).join('\n');
  return `[Unit]
Description=TokenStack Headroom AI Proxy
After=network.target

[Service]
ExecStart=${headroomBin} proxy --port ${port}
Restart=always
RestartSec=10
${envLines}

[Install]
WantedBy=default.target`;
}

export function unitPath() {
  return join(homedir(), '.config', 'systemd', 'user', 'tokenstack-headroom.service');
}

export function installService(opts) {
  const content = generateSystemdUnit(opts);
  const p = unitPath();
  mkdirSync(join(homedir(), '.config', 'systemd', 'user'), { recursive: true });
  writeFileSync(p, content, 'utf8');
  execSync('systemctl --user daemon-reload');
  execSync('systemctl --user enable --now tokenstack-headroom.service');
}

export function serviceStatus() {
  try {
    execSync('systemctl --user is-active tokenstack-headroom.service', { stdio: 'ignore' });
    return { running: true };
  } catch {
    return { running: false };
  }
}
