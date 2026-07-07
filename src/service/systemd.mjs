import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { execSync } from 'node:child_process';

export function generateSystemdUnit({ headroomBin, port, envVars = {} }) {
  const envLines = Object.entries(envVars).map(([k, v]) => `Environment=${k}=${v}`).join('\n');
  return `[Unit]
Description=Myelin Headroom AI Proxy
After=network.target

[Service]
ExecStart=${headroomBin} proxy --port ${port}
Restart=always
RestartSec=10
${envLines}

[Install]
WantedBy=default.target`;
}

export function generateMitmUnit({ mitmdumpBin, port, addonPath, args, envVars = {} }) {
  const execArgs = args ?? ['--listen-port', String(port), '-s', addonPath];
  const envLines = Object.entries(envVars).map(([k, v]) => `Environment=${k}=${v}`).join('\n');
  return `[Unit]
Description=Myelin mitmproxy LLM compression proxy
After=network.target tokenstack-headroom.service

[Service]
ExecStart=${mitmdumpBin} ${execArgs.join(' ')}
Restart=always
RestartSec=10
${envLines}

[Install]
WantedBy=default.target`;
}

export function unitPath() {
  return join(homedir(), '.config', 'systemd', 'user', 'tokenstack-headroom.service');
}

export function mitmUnitPath() {
  return join(homedir(), '.config', 'systemd', 'user', 'myelin-mitmproxy.service');
}

export function installService(opts) {
  const content = generateSystemdUnit(opts);
  const p = unitPath();
  mkdirSync(join(homedir(), '.config', 'systemd', 'user'), { recursive: true });
  writeFileSync(p, content, 'utf8');
  execSync('systemctl --user daemon-reload');
  execSync('systemctl --user enable --now tokenstack-headroom.service');
}

export function installMitmService({ mitmdumpBin, port, addonPath, envVars = {} }) {
  const args = ['--listen-port', String(port), '-s', addonPath];
  const proxy = envVars.HTTPS_PROXY || envVars.https_proxy || '';
  if (proxy) args.push('--mode', `upstream:${proxy}`);
  const caBundle = envVars.SSL_CERT_FILE || envVars.REQUESTS_CA_BUNDLE ||
                   envVars.NODE_EXTRA_CA_CERTS || envVars.HEADROOM_CA_BUNDLE || '';
  if (caBundle) args.push('--set', `ssl_verify_upstream_trusted_ca=${caBundle}`);
  args.push('--ignore-hosts', String.raw`.*\.akamai\.com|.*\.corp\.akamai\.com|.*\.akamaized\.net|.*\.akamaihd\.net`);
  const p = mitmUnitPath();
  mkdirSync(join(homedir(), '.config', 'systemd', 'user'), { recursive: true });
  writeFileSync(p, content, 'utf8');
  execSync('systemctl --user daemon-reload');
  execSync('systemctl --user enable --now myelin-mitmproxy.service');
}

export function mitmServiceStatus() {
  try {
    execSync('systemctl --user is-active myelin-mitmproxy.service', { stdio: 'ignore' });
    return { running: true };
  } catch {
    return { running: false };
  }
}

export function serviceStatus() {
  try {
    execSync('systemctl --user is-active tokenstack-headroom.service', { stdio: 'ignore' });
    return { running: true };
  } catch {
    return { running: false };
  }
}
