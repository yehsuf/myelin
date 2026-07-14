import { writeFileSync, mkdirSync, existsSync, unlinkSync } from 'node:fs';
import { join, posix as pathPosix } from 'node:path';
import { homedir } from 'node:os';
import { execSync } from 'node:child_process';
import { buildServiceEnvUnsetLines, SERVER_FORBIDDEN_ENV } from './wrappers.mjs';
import { resolveHeadroomLiteEntrypoint } from './headroom-lite-command.mjs';

const LABEL      = 'com.myelin.headroom';
const MITM_LABEL = 'com.myelin.mitmproxy';
const WATCHDOG_LABEL = 'com.myelin.watchdog';
const COPILOT_HEADROOM_LABEL = 'com.myelin.copilot-headroom';

function engineInstanceIdentity(instance = {}) {
  if (instance.role === 'primary') {
    return {
      label: LABEL,
      serviceId: 'myelin-headroom',
      name: 'Myelin Headroom',
    };
  }
  if (instance.role === 'copilot') {
    return {
      label: COPILOT_HEADROOM_LABEL,
      serviceId: 'myelin-copilot-headroom',
      name: 'Myelin Copilot Headroom',
    };
  }
  throw new Error(`Unsupported engine instance role: ${instance.role}`);
}

function engineInstanceCommand(instance = {}, { headroomBin, headroomLiteBin } = {}) {
  if (instance.engine === 'headroom') {
    if (!headroomBin) throw new Error('headroomBin is required for headroom engine instances');
    return {
      command: headroomBin,
      args: ['proxy', '--port', String(instance.port)],
      env: {},
    };
  }
  if (instance.engine === 'headroom_lite') {
    if (!headroomLiteBin) throw new Error('headroomLiteBin is required for headroom_lite engine instances');
    return {
      command: process.execPath,
      args: [resolveHeadroomLiteEntrypoint(headroomLiteBin)],
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
  logPath,
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
    logPath: logPath ?? join(home, '.myelin', `${id}.log`),
    healthUrl: `http://127.0.0.1:${port}/health`,
    env: envVars,
  };
}

/**
 * Wrap a command + args in a `/bin/sh -c 'unset X Y; exec <cmd> <args>'` shell
 * invocation, escaping single-quotes safely for XML/shell double-embedding.
 *
 * Why: launchd's EnvironmentVariables dict is additive on top of whatever
 * env launchd itself carries (from its own initialization and any
 * `launchctl setenv` values). It cannot express "unset these". Wrapping
 * through /bin/sh with an explicit `unset` before `exec` guarantees the
 * spawned service never sees inherited client-side provider vars.
 */
function shWrappedProgramArgs(command, args) {
  const unset = buildServiceEnvUnsetLines({ os: 'darwin' });
  const escapedParts = [command, ...args].map(p => {
    // Escape XML entities on shell tokens later — for now escape single-quotes
    // for the outer sh -c '...' by ending the quoted string, adding a
    // backslash-quoted quote, and reopening the quote: `it's` → `it'\''s`.
    return String(p).replace(/'/g, `'\\''`);
  });
  const inner = `${unset}; exec ${escapedParts.map(p => `'${p}'`).join(' ')}`;
  return ['/bin/sh', '-c', inner];
}

function xmlEscape(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export function generatePlist(opts = {}) {
  const mergedEnv = opts.interceptToolResults
    ? { HEADROOM_INTERCEPT_ENABLED: '1', ...opts.envVars }
    : (opts.envVars ?? {});
  return generateEngineInstancePlist({
    ...opts,
    instance: legacyEngineInstance({ ...opts, role: 'primary', envVars: mergedEnv }),
    envVars: {},
  });
}

export function plistPath() {
  return join(homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);
}

export function mitmPlistPath(home = homedir()) {
  return pathPosix.join(home, 'Library', 'LaunchAgents', `${MITM_LABEL}.plist`);
}

/** Generic plist generator — use for any long-running LaunchAgent.
 *  Wraps the command through `/bin/sh -c 'unset ...; exec cmd args'` so the
 *  service never inherits stray client-side provider env vars from launchd's
 *  own environment (launchd's EnvironmentVariables dict is additive, not a
 *  filter). */
export function generateGenericPlist({ label, command, args = [], envVars = {}, logPath, workingDirectory }) {
  const envEntries = Object.entries(envVars)
    .map(([k, v]) => `        <key>${k}</key>\n        <string>${xmlEscape(v)}</string>`)
    .join('\n');
  const progArgs = shWrappedProgramArgs(command, args);
  const argItems = progArgs
    .map(a => `        <string>${xmlEscape(a)}</string>`)
    .join('\n');
  const workingDirEntry = workingDirectory
    ? `\n    <key>WorkingDirectory</key>\n    <string>${xmlEscape(workingDirectory)}</string>`
    : '';
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
    <string>${logPath ?? '/tmp/myelin.log'}</string>${workingDirEntry}
</dict>
</plist>`;
}

export function generateEngineInstancePlist({ instance, envVars = {}, ...options }) {
  const { label } = engineInstanceIdentity(instance);
  const command = engineInstanceCommand(instance, options);
  return generateGenericPlist({
    label,
    command: command.command,
    args: command.args,
    envVars: { ...command.env, ...envVars, ...instance.env },
    logPath: instance.logPath,
    workingDirectory: instance.stateDir,
  });
}

export function engineInstancePlistPath(instance) {
  const { label } = engineInstanceIdentity(instance);
  return join(homedir(), 'Library', 'LaunchAgents', `${label}.plist`);
}

export function installEngineInstance(instance, options = {}) {
  const { label } = engineInstanceIdentity(instance);
  const p = engineInstancePlistPath(instance);
  const content = generateEngineInstancePlist({ instance, ...options });
  mkdirSync(instance.stateDir, { recursive: true });
  mkdirSync(join(homedir(), 'Library', 'LaunchAgents'), { recursive: true });
  writeFileSync(p, content, 'utf8');
  const uid = process.getuid?.() ?? execSync('id -u').toString().trim();
  try { execSync(`launchctl bootout gui/${uid}/${label}`, { stdio: 'ignore' }); } catch {}
  execSync('sleep 1');
  execSync(`launchctl bootstrap gui/${uid} ${p}`);
}

export function engineInstanceStatus(instance) {
  const { label } = engineInstanceIdentity(instance);
  try {
    const out = execSync(`launchctl list ${label} 2>&1`).toString();
    return {
      running: !out.includes('Could not find service'),
      label,
      healthUrl: instance.healthUrl,
      raw: out,
    };
  } catch {
    return { running: false, label, healthUrl: instance.healthUrl, raw: '' };
  }
}

export function removeEngineInstance(instance) {
  const { label } = engineInstanceIdentity(instance);
  const p = engineInstancePlistPath(instance);
  const uid = process.getuid?.() ?? execSync('id -u').toString().trim();
  try { execSync(`launchctl bootout gui/${uid}/${label}`, { stdio: 'ignore' }); } catch {}
  if (existsSync(p)) unlinkSync(p);
}

/** Install mitmproxy as a LaunchAgent running the Myelin addon.
 *  If an enterprise upstream proxy is set (via envVars.HTTPS_PROXY),
 *  mitmproxy is started in upstream mode so it chains through it.
 *
 *  When egressPort is provided, a SECOND listener is added to the SAME
 *  mitmdump process (--mode regular@PORT twice) instead of --listen-port.
 *  This is the egress-only leg used by a dedicated Copilot-Headroom
 *  instance's own outbound calls (see copilot_headroom config) — it never
 *  redirects (arrival-port gating in the addon itself), it only owns real
 *  network egress (block-bypass/CA/corp-upstream) for that instance.
 */
export function installMitmService({ mitmdumpBin, port, addonPath, envVars = {}, logPath, home, upstreamProxy, egressPort }) {
  const p = mitmPlistPath();
  const args = egressPort
    ? ['--mode', `regular@${port}`, '--mode', `regular@127.0.0.1:${egressPort}`, '-s', addonPath]
    : ['--listen-port', String(port), '-s', addonPath];

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
  //
  // IMPORTANT: *.githubcopilot.com must NEVER be in this list — that is the
  // exact Copilot LLM API host this proxy exists to intercept and compress.
  // A prior commit (75ae072) accidentally added it alongside api.github.com/
  // *.github.com (added for git/gh-cli passthrough, unrelated to mTLS), which
  // silently disabled 100% of Copilot compression. api.github.com/*.github.com
  // are left as-is pending confirmation of their original intent.
  const IGNORE_HOSTS = [
    String.raw`.*\.akamai\.com`,
    String.raw`.*\.corp\.akamai\.com`,
    String.raw`.*\.akamaized\.net`,
    String.raw`.*\.akamaihd\.net`,
    String.raw`api\.github\.com`,
    String.raw`.*\.github\.com`,
  ].join('|');
  args.push('--ignore-hosts', IGNORE_HOSTS);

  const content = generateGenericPlist({
    label: MITM_LABEL,
    command: mitmdumpBin,
    args,
    envVars: {
      MYELIN_HEADROOM_PORT: String(envVars.HEADROOM_PORT ?? 8787),
      ...(egressPort ? { MYELIN_EGRESS_PORT: String(egressPort) } : {}),
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

export function removeMitmService({
  home = homedir(),
  uid = process.getuid?.() ?? execSync('id -u').toString().trim(),
  existsSyncImpl = existsSync,
  unlinkSyncImpl = unlinkSync,
  execSyncImpl = execSync,
} = {}) {
  const p = mitmPlistPath(home);
  try { execSyncImpl(`launchctl bootout gui/${uid}/${MITM_LABEL}`, { stdio: 'ignore' }); } catch {}
  if (existsSyncImpl(p)) unlinkSyncImpl(p);
  return true;
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
  return installEngineInstance(legacyEngineInstance({ ...opts, role: 'primary' }), opts);
}

export function copilotHeadroomPlistPath() {
  return join(homedir(), 'Library', 'LaunchAgents', `${COPILOT_HEADROOM_LABEL}.plist`);
}

/**
 * Install a SEPARATE, dedicated Headroom instance for Copilot CLI traffic
 * (distinct from the Claude-Headroom instance installed by installService).
 * Given its own isolated WorkingDirectory so its memory/cache/stats state
 * ({cwd}/.headroom/...) never collides with the Claude-Headroom instance's
 * own state — headroom has no dedicated HEADROOM_HOME-style env var, so
 * WorkingDirectory is the isolation mechanism (confirmed against headroom's
 * own --memory-db-path default of "{cwd}/.headroom/memory.db").
 */
export function installCopilotHeadroomService(opts = {}) {
  return installEngineInstance(legacyEngineInstance({ ...opts, role: 'copilot' }), opts);
}

export function copilotHeadroomServiceStatus(opts = {}) {
  return engineInstanceStatus(legacyEngineInstance({ ...opts, role: 'copilot' }));
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
export function generateLaunchdWatchdogScript({ home, headroomPort, mitmPort, copilotHeadroomPort, egressPort } = {}) {
  home = home ?? homedir();
  const la = join(home, 'Library', 'LaunchAgents');
  const watchdogLog = join(home, '.myelin', 'watchdog.log');
  const checks = [
    ...(mitmPort != null ? [`check_and_revive ${mitmPort} mitmproxy '*.mitmproxy.plist'`] : []),
    ...(headroomPort != null ? [`check_and_revive ${headroomPort} headroom '*.headroom.plist'`] : []),
    ...(copilotHeadroomPort ? [`check_and_revive ${copilotHeadroomPort} copilot-headroom '*.copilot-headroom.plist'`] : []),
    ...(mitmPort != null && egressPort ? [`check_and_revive ${egressPort} mitmproxy-egress '*.mitmproxy.plist'`] : []),
  ];

  return `#!/usr/bin/env bash
# Myelin watchdog — re-bootstraps headroom/mitmproxy if launchd silently dropped them.
set -uo pipefail
UID_N=$(id -u)
LA="${la}"

check_and_revive() {
  local port="$1" name="$2" glob="$3"
  if nc -z 127.0.0.1 "$port" 2>/dev/null; then return 0; fi
  local plist
  plist=$(ls "$LA"/$glob 2>/dev/null | grep -v '\.bak' | head -1)
  if [ -z "$plist" ]; then return 0; fi
  local label
  label=$(basename "$plist" .plist)
  launchctl bootout "gui/$UID_N/$label" 2>/dev/null
  sleep 1
  launchctl bootstrap "gui/$UID_N" "$plist" 2>/dev/null
  echo "[watchdog] $(date '+%Y-%m-%d %H:%M:%S') revived $name ($label)" >> "${watchdogLog}"
}

${checks.join('\n')}
`;
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
export function installWatchdog({ home, headroomPort, mitmPort, copilotHeadroomPort, egressPort } = {}) {
  home = home ?? homedir();
  const binDir = join(home, '.myelin', 'bin');
  mkdirSync(binDir, { recursive: true });
  const scriptPath = join(binDir, 'watchdog.sh');
  const la = join(home, 'Library', 'LaunchAgents');
  const watchdogLog = join(home, '.myelin', 'watchdog.log');

  const script = generateLaunchdWatchdogScript({ home, headroomPort, mitmPort, copilotHeadroomPort, egressPort });
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
  return engineInstanceStatus(legacyEngineInstance({ role: 'primary' }));
}
