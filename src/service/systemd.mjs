import { writeFileSync, mkdirSync, existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { execSync } from 'node:child_process';
import { buildServiceEnvUnsetLines } from './wrappers.mjs';

function engineInstanceIdentity(instance = {}) {
  if (instance.role === 'primary') {
    return {
      serviceId: 'myelin-headroom',
      description: 'Myelin Headroom AI Proxy',
    };
  }
  if (instance.role === 'copilot') {
    return {
      serviceId: 'myelin-copilot-headroom',
      description: 'Myelin Copilot-Headroom AI Proxy (dedicated Copilot CLI instance)',
    };
  }
  throw new Error(`Unsupported engine instance role: ${instance.role}`);
}

function engineInstanceCommand(instance = {}, { headroomBin, headroomLiteBin } = {}) {
  if (instance.engine === 'headroom') {
    if (!headroomBin) throw new Error('headroomBin is required for headroom engine instances');
    return {
      executable: headroomBin,
      args: ['proxy', '--port', String(instance.port)],
      env: {},
    };
  }
  if (instance.engine === 'headroom_lite') {
    if (!headroomLiteBin) throw new Error('headroomLiteBin is required for headroom_lite engine instances');
    return {
      executable: headroomLiteBin,
      args: [],
      env: { HEADROOM_LITE_PORT: String(instance.port) },
    };
  }
  throw new Error(`Unsupported engine instance engine: ${instance.engine}`);
}

function legacyEngineInstance({
  instance,
  engine = 'headroom',
  role,
  port,
  envVars = {},
  home = homedir(),
} = {}) {
  if (instance) return instance;
  const id = `${engine}-${role}`;
  return {
    engine,
    role,
    port,
    id,
    stateDir: join(home, '.myelin', 'state', id),
    logPath: join(home, '.myelin', `${id}.log`),
    healthUrl: `http://127.0.0.1:${port}/health`,
    env: envVars,
  };
}

export function generateSystemdUnit(opts = {}) {
  const mergedEnv = opts.interceptToolResults
    ? { HEADROOM_INTERCEPT_ENABLED: '1', ...opts.envVars }
    : (opts.envVars ?? {});
  return generateEngineInstanceUnit({
    ...opts,
    instance: legacyEngineInstance({ ...opts, role: 'primary', envVars: mergedEnv }),
    envVars: {},
  });
}

/**
 * Unit for the SEPARATE, dedicated Copilot-Headroom instance (distinct from
 * the Claude-Headroom unit above). WorkingDirectory= gives it its own
 * memory/cache/stats state directory ({cwd}/.headroom/...) so it never
 * collides with the Claude-Headroom instance's own state — headroom has no
 * dedicated HEADROOM_HOME-style env var, so cwd is the isolation mechanism
 * (matches launchd.mjs's WorkingDirectory plist key on macOS).
 */
export function generateCopilotHeadroomUnit(opts = {}) {
  const selectedEngine = opts.engine ?? 'headroom';
  const stateDir = opts.workingDirectory ?? join(homedir(), '.myelin', 'state', `${selectedEngine}-copilot`);
  return generateEngineInstanceUnit({
    ...opts,
    instance: opts.instance ?? {
      engine: selectedEngine,
      role: 'copilot',
      port: opts.port,
      id: `${selectedEngine}-copilot`,
      stateDir,
      logPath: join(homedir(), '.myelin', `${selectedEngine}-copilot.log`),
      healthUrl: `http://127.0.0.1:${opts.port}/health`,
      env: opts.envVars ?? {},
    },
    envVars: {},
  });
}

export function generateEngineInstanceUnit({ instance, envVars = {}, ...options }) {
  const { serviceId, description } = engineInstanceIdentity(instance);
  const command = engineInstanceCommand(instance, options);
  const mergedEnv = { ...command.env, ...envVars, ...instance.env };
  const envLines = Object.entries(mergedEnv).map(([k, v]) => `Environment=${k}=${v}`).join('\n');
  const unsetLines = buildServiceEnvUnsetLines({ os: 'linux' });
  return `[Unit]
Description=${description} (${serviceId})
After=network.target

[Service]
ExecStart=${command.executable}${command.args.length ? ` ${command.args.join(' ')}` : ''}
WorkingDirectory=${instance.stateDir}
StandardOutput=append:${instance.logPath}
StandardError=append:${instance.logPath}
Restart=always
RestartSec=10
${unsetLines}
${envLines}

[Install]
WantedBy=default.target`;
}

export function engineInstanceUnitPath(instance) {
  const { serviceId } = engineInstanceIdentity(instance);
  return join(homedir(), '.config', 'systemd', 'user', `${serviceId}.service`);
}

export function installEngineInstance(instance, options = {}) {
  const { serviceId } = engineInstanceIdentity(instance);
  const content = generateEngineInstanceUnit({ instance, ...options });
  const p = engineInstanceUnitPath(instance);
  mkdirSync(instance.stateDir, { recursive: true });
  mkdirSync(join(homedir(), '.config', 'systemd', 'user'), { recursive: true });
  writeFileSync(p, content, 'utf8');
  execSync('systemctl --user daemon-reload');
  execSync(`systemctl --user enable ${serviceId}.service`);
  execSync(`systemctl --user restart ${serviceId}.service`);
}

export function engineInstanceStatus(instance) {
  const { serviceId } = engineInstanceIdentity(instance);
  try {
    execSync(`systemctl --user is-active ${serviceId}.service`, { stdio: 'ignore' });
    return { running: true, label: serviceId, healthUrl: instance.healthUrl };
  } catch {
    return { running: false, label: serviceId, healthUrl: instance.healthUrl };
  }
}

export function removeEngineInstance(instance) {
  const { serviceId } = engineInstanceIdentity(instance);
  const p = engineInstanceUnitPath(instance);
  try { execSync(`systemctl --user disable --now ${serviceId}.service`, { stdio: 'ignore' }); } catch {}
  if (existsSync(p)) unlinkSync(p);
  execSync('systemctl --user daemon-reload');
}

export function generateMitmUnit({ mitmdumpBin, port, addonPath, args, envVars = {} }) {
  const execArgs = args ?? ['--listen-port', String(port), '-s', addonPath];
  const envLines = Object.entries(envVars).map(([k, v]) => `Environment=${k}=${v}`).join('\n');
  const unsetLines = buildServiceEnvUnsetLines({ os: 'linux' });
  return `[Unit]
Description=Myelin mitmproxy LLM compression proxy
After=network.target myelin-headroom.service

[Service]
ExecStart=${mitmdumpBin} ${execArgs.join(' ')}
Restart=always
RestartSec=10
${unsetLines}
${envLines}

[Install]
WantedBy=default.target`;
}

export function unitPath() {
  return join(homedir(), '.config', 'systemd', 'user', 'myelin-headroom.service');
}

export function copilotHeadroomUnitPath() {
  return join(homedir(), '.config', 'systemd', 'user', 'myelin-copilot-headroom.service');
}

export function mitmUnitPath(home = homedir()) {
  return join(home, '.config', 'systemd', 'user', 'myelin-mitmproxy.service');
}

export function installService(opts) {
  return installEngineInstance(legacyEngineInstance({ ...opts, role: 'primary' }), opts);
}

export function installCopilotHeadroomService(opts = {}) {
  return installEngineInstance(legacyEngineInstance({ ...opts, role: 'copilot' }), opts);
}

export function copilotHeadroomServiceStatus(opts = {}) {
  return engineInstanceStatus(legacyEngineInstance({ ...opts, role: 'copilot' }));
}

export function installMitmService({ mitmdumpBin, port, addonPath, envVars = {}, egressPort }) {
  const args = egressPort
    ? ['--mode', `regular@${port}`, '--mode', `regular@127.0.0.1:${egressPort}`, '-s', addonPath]
    : ['--listen-port', String(port), '-s', addonPath];
  const proxy = envVars.HTTPS_PROXY || envVars.https_proxy || '';
  if (proxy && !proxy.includes('127.0.0.1') && !proxy.includes('localhost')) args.push('--mode', `upstream:${proxy}`);
  const caBundle = envVars.SSL_CERT_FILE || envVars.REQUESTS_CA_BUNDLE ||
                   envVars.NODE_EXTRA_CA_CERTS || envVars.HEADROOM_CA_BUNDLE || '';
  if (caBundle) args.push('--set', `ssl_verify_upstream_trusted_ca=${caBundle}`);
  args.push('--ignore-hosts', String.raw`.*\.akamai\.com|.*\.corp\.akamai\.com|.*\.akamaized\.net|.*\.akamaihd\.net`);
  const content = generateMitmUnit({
    mitmdumpBin, port, addonPath, args,
    envVars: { ...(egressPort ? { MYELIN_EGRESS_PORT: String(egressPort) } : {}), ...envVars },
  });
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

export function removeMitmService({
  home = homedir(),
  existsSyncImpl = existsSync,
  unlinkSyncImpl = unlinkSync,
  execSyncImpl = execSync,
} = {}) {
  const p = mitmUnitPath(home);
  try { execSyncImpl('systemctl --user disable --now myelin-mitmproxy.service', { stdio: 'ignore' }); } catch {}
  if (existsSyncImpl(p)) unlinkSyncImpl(p);
  execSyncImpl('systemctl --user daemon-reload');
  return true;
}

export function mitmServiceStatus() {
  try {
    execSync('systemctl --user is-active myelin-mitmproxy.service', { stdio: 'ignore' });
    return { running: true };
  } catch {
    return { running: false };
  }
}

export function serviceStatus(opts = {}) {
  return engineInstanceStatus(legacyEngineInstance({ ...opts, role: 'primary' }));
}
