import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { execSync } from 'node:child_process';

export function generateSystemdUnit({ headroomBin, port, envVars = {}, interceptToolResults }) {
  const envLines = Object.entries(envVars).map(([k, v]) => `Environment=${k}=${v}`).join('\n');
  const extraArgs = interceptToolResults ? ' --intercept-tool-results' : '';
  return `[Unit]
Description=Myelin Headroom AI Proxy
After=network.target

[Service]
ExecStart=${headroomBin} proxy --port ${port}${extraArgs}
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
After=network.target myelin-headroom.service

[Service]
ExecStart=${mitmdumpBin} ${execArgs.join(' ')}
Restart=always
RestartSec=10
${envLines}

[Install]
WantedBy=default.target`;
}

export function unitPath() {
  return join(homedir(), '.config', 'systemd', 'user', 'myelin-headroom.service');
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
  execSync('systemctl --user enable myelin-headroom.service');
  // `enable --now` only starts a unit if it isn't already active — it does
  // NOT restart an already-running service, so a changed ExecStart (e.g.
  // a repo path migration) would silently keep the OLD process running
  // forever with stale arguments. `restart` starts it if stopped and
  // cleanly restarts it if running, so it's always correct here.
  execSync('systemctl --user restart myelin-headroom.service');
}

export function installMitmService({ mitmdumpBin, port, addonPath, envVars = {} }) {
  const args = ['--listen-port', String(port), '-s', addonPath];
  const proxy = envVars.HTTPS_PROXY || envVars.https_proxy || '';
  if (proxy && !proxy.includes('127.0.0.1') && !proxy.includes('localhost')) args.push('--mode', `upstream:${proxy}`);
  const caBundle = envVars.SSL_CERT_FILE || envVars.REQUESTS_CA_BUNDLE ||
                   envVars.NODE_EXTRA_CA_CERTS || envVars.HEADROOM_CA_BUNDLE || '';
  if (caBundle) args.push('--set', `ssl_verify_upstream_trusted_ca=${caBundle}`);
  args.push('--ignore-hosts', String.raw`.*\.akamai\.com|.*\.corp\.akamai\.com|.*\.akamaized\.net|.*\.akamaihd\.net`);
  const content = generateMitmUnit({ mitmdumpBin, port, addonPath, args, envVars });
  const p = mitmUnitPath();
  mkdirSync(join(homedir(), '.config', 'systemd', 'user'), { recursive: true });
  writeFileSync(p, content, 'utf8');
  execSync('systemctl --user daemon-reload');
  execSync('systemctl --user enable myelin-mitmproxy.service');
  // See installService() above — `enable --now` doesn't restart an
  // already-running unit, which left a stale mitmdump process (pointing at
  // a deleted ~/.tokenstack path) running for 7+ hours after today's
  // ~/.tokenstack -> ~/.myelin migration, silently failing every TLS
  // connection to api.business.githubcopilot.com. `restart` is always
  // correct: starts if stopped, cleanly restarts if already running.
  execSync('systemctl --user restart myelin-mitmproxy.service');
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
    execSync('systemctl --user is-active myelin-headroom.service', { stdio: 'ignore' });
    return { running: true };
  } catch {
    return { running: false };
  }
}
