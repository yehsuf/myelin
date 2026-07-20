import { writeFileSync, mkdirSync, existsSync, readFileSync, unlinkSync } from 'node:fs';
import { join, posix as pathPosix } from 'node:path';
import { homedir } from 'node:os';
import { execSync, execFileSync } from 'node:child_process';
import { buildServiceEnvUnsetLines } from './wrappers.mjs';
import { resolveHeadroomLiteEntrypoint } from './headroom-lite-command.mjs';
import { managedPaths, joinManaged, withForwardedMyelinDir } from '../shared/myelin-paths.mjs';

function engineInstanceIdentity(instance = {}) {
  if (instance.role === 'primary') {
    return {
      serviceId: 'myelin-compression',
      description: 'Myelin Headroom AI Proxy',
    };
  }
  if (instance.role === 'copilot') {
    return {
      serviceId: 'myelin-copilot-compression',
      description: 'Myelin Copilot-Headroom AI Proxy (dedicated Copilot CLI instance)',
    };
  }
  throw new Error(`Unsupported engine instance role: ${instance.role}`);
}

function engineInstanceCommand(instance = {}, {
  headroomBin,
  headroomLiteBin,
  nodePath = process.execPath,
} = {}) {
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
      executable: nodePath,
      args: [resolveHeadroomLiteEntrypoint(headroomLiteBin)],
      env: { HEADROOM_LITE_PORT: String(instance.port), HEADROOM_LITE_STATS_PATH: join(instance.stateDir, 'telemetry.json') },
    };
  }
  throw new Error(`Unsupported engine instance engine: ${instance.engine}`);
}

function systemdArgument(value) {
  return `"${String(value)
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\$/g, '$$$$')
    .replace(/%/g, '%%')}"`;
}

/**
 * Does an ExecStart/Environment token need double-quoting to survive systemd's
 * word-splitting? Anything with whitespace (the actual token-splitter),
 * quotes, backslashes, or the `$`/`%` expansion sigils must be quoted+escaped;
 * a plain path/flag stays bare so simple units render human-readably (and so
 * historical `ExecStart=/bin/foo proxy --port N` assertions keep matching).
 */
function needsSystemdQuoting(value) {
  const str = String(value ?? '');
  return str === '' || /[\s"'\\$%]/u.test(str);
}

/** Quote+escape an ExecStart token only when systemd word-splitting would
 *  otherwise mangle it (e.g. a path like `/srv/Myelin Data/headroom`). */
function systemdExecToken(value) {
  return needsSystemdQuoting(value) ? systemdArgument(value) : String(value ?? '');
}

/**
 * Escape a value for a double-quoted systemd `Environment="KEY=VALUE"` line.
 * `\` and `"` are escaped for the double-quoted context; `%` is doubled so a
 * literal percent is not mistaken for a `%`-specifier at unit load. `$` is left
 * verbatim — Environment= assignments are NOT subject to `$`/`${}` expansion
 * (that only happens on the command line), so doubling it would corrupt paths.
 */
function systemdEnvironmentValue(value) {
  return String(value ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/%/g, '%%');
}

/**
 * Render a single `Environment=` line. A value that would break systemd's
 * space-separated assignment parsing (whitespace/quote/backslash/percent, or an
 * empty value) is wrapped in double quotes as `Environment="KEY=VALUE"`; a
 * simple value stays bare as `Environment=KEY=VALUE` for readability and
 * backward compatibility.
 */
function systemdEnvironmentLine(key, value) {
  const raw = String(value ?? '');
  if (needsSystemdQuoting(raw)) {
    return `Environment="${key}=${systemdEnvironmentValue(raw)}"`;
  }
  return `Environment=${key}=${raw}`;
}

function systemdEnvironmentLines(env = {}) {
  return Object.entries(env).map(([k, v]) => systemdEnvironmentLine(k, v)).join('\n');
}

/**
 * Count the words systemd would parse from an ExecStart value, honoring
 * double-quote grouping and backslash escapes. Used to prove a rendered
 * ExecStart never accidentally splits a single token (path with a space) into
 * several.
 */
function systemdExecWordCount(execValue) {
  const str = String(execValue ?? '');
  let count = 0;
  let inWord = false;
  let inQuote = false;
  for (let i = 0; i < str.length; i++) {
    const c = str[i];
    if (c === '\\') {
      if (!inWord) { inWord = true; count++; }
      i++; // skip the escaped character
      continue;
    }
    if (c === '"') {
      inQuote = !inQuote;
      if (!inWord) { inWord = true; count++; }
      continue;
    }
    if (!inQuote && /\s/u.test(c)) {
      inWord = false;
      continue;
    }
    if (!inWord) { inWord = true; count++; }
  }
  return count;
}

function hasBalancedSystemdQuotes(execValue) {
  const str = String(execValue ?? '');
  let inQuote = false;
  for (let i = 0; i < str.length; i++) {
    const c = str[i];
    if (c === '\\') { i++; continue; }
    if (c === '"') inQuote = !inQuote;
  }
  return !inQuote;
}

/**
 * Build the ExecStart token list into a single line, quoting each token via
 * `tokenFn`, then self-validate that systemd would parse back exactly the same
 * number of tokens (i.e. no unquoted space silently split a path). Throws
 * before the unit is ever written.
 */
function renderSystemdExecStart(tokens, tokenFn = systemdExecToken) {
  const rendered = tokens.map(tokenFn).join(' ');
  if (systemdExecWordCount(rendered) !== tokens.length) {
    throw new Error(`systemd ExecStart rendering would mis-split a token: ${rendered}`);
  }
  return rendered;
}

/**
 * Validate a fully-rendered systemd unit before it is written/replaced: every
 * `ExecStart=` line must have balanced double-quotes so no exec token carries an
 * unquoted space that would break the restarted unit definition. Returns the
 * unit unchanged on success; throws otherwise.
 */
export function validateSystemdUnit(unit) {
  const text = String(unit ?? '');
  for (const line of text.split('\n')) {
    if (!line.startsWith('ExecStart=')) continue;
    const value = line.slice('ExecStart='.length);
    if (!hasBalancedSystemdQuotes(value)) {
      throw new Error(`Invalid systemd ExecStart (unbalanced quoting, exec token would split): ${line}`);
    }
  }
  return unit;
}

function legacyEngineInstance({
  instance,
  engine = 'headroom',
  role,
  port,
  envVars = {},
  home = homedir(),
  env = process.env,
} = {}) {
  if (instance) return instance;
  const id = `${engine}-${role}`;
  const root = managedPaths({ home, env }).root;
  return {
    engine,
    role,
    port,
    id,
    stateDir: joinManaged(root, 'state', id),
    logPath: joinManaged(root, `${id}.log`),
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
  const root = managedPaths({ home: opts.home ?? homedir(), env: opts.env }).root;
  const stateDir = opts.workingDirectory ?? joinManaged(root, 'state', `${selectedEngine}-copilot`);
  return generateEngineInstanceUnit({
    ...opts,
    instance: opts.instance ?? {
      engine: selectedEngine,
      role: 'copilot',
      port: opts.port,
      id: `${selectedEngine}-copilot`,
      stateDir,
      logPath: joinManaged(root, `${selectedEngine}-copilot.log`),
      healthUrl: `http://127.0.0.1:${opts.port}/health`,
      env: opts.envVars ?? {},
    },
    envVars: {},
  });
}

/**
 * Reject a value destined for a raw (unquoted) systemd directive body when it
 * carries a control character. A newline/CR in a MYELIN_DIR-derived
 * WorkingDirectory/StandardOutput/StandardError/ExecStart path would start a NEW
 * unit line — injecting arbitrary directives that sail past
 * {@link validateSystemdUnit} (its quote-balance check treats a newline as a
 * plain line break). The whole C0 range + DEL have no legitimate place in a
 * service path, so throw before the unit is ever rendered.
 * @param {unknown} value
 * @param {string} label
 */
function assertNoSystemdControlChars(value, label) {
  const str = String(value ?? '');
  const match = /[\u0000-\u001F\u007F]/u.exec(str);
  if (match) {
    const code = match[0].charCodeAt(0).toString(16).padStart(2, '0');
    throw new Error(
      `Refusing to render systemd unit: ${label} contains control character U+00${code.toUpperCase()} `
      + `(newline/CR/etc.) that could inject unit directives: ${JSON.stringify(str)}`,
    );
  }
}

/**
 * Guard EVERY environment key AND value spliced into `Environment=` lines. A
 * newline in a MYELIN_DIR-derived (or otherwise forwarded) env key/value would
 * otherwise start a NEW unit line — injecting arbitrary directives that sail
 * past {@link validateSystemdUnit} (whose quote-balance check treats a newline
 * as a plain line break). Applied to the fully-merged env of BOTH unit
 * generators before any line is rendered.
 * @param {Record<string, unknown>} mergedEnv
 */
function assertNoSystemdEnvControlChars(mergedEnv = {}) {
  for (const [key, value] of Object.entries(mergedEnv)) {
    assertNoSystemdControlChars(key, `Environment key ${JSON.stringify(key)}`);
    assertNoSystemdControlChars(value, `Environment value for key ${JSON.stringify(key)}`);
  }
}

/**
 * Return true when `port` has a process actively listening on 127.0.0.1.
 */
export function isPortResponding(port, { execFileSyncImpl = execFileSync } = {}) {
  if (port == null) return false;
  try {
    execFileSyncImpl('nc', ['-z', '-w', '1', '127.0.0.1', String(port)], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Return true when the file at `path` already contains exactly `content`.
 */
export function isUnitUnchanged(path, content, { readFileSyncImpl = readFileSync, existsSyncImpl = existsSync } = {}) {
  if (!existsSyncImpl(path)) return false;
  try {
    return readFileSyncImpl(path, 'utf8') === content;
  } catch {
    return false;
  }
}

export function generateEngineInstanceUnit({ instance, envVars = {}, env = process.env, ...options }) {
  const { serviceId, description } = engineInstanceIdentity(instance);
  const command = engineInstanceCommand(instance, options);
  // Guard every value spliced into a raw directive body (WorkingDirectory,
  // StandardOutput/Error, ExecStart tokens). A newline in the managed root would
  // otherwise inject directives that pass validateSystemdUnit's quote-balance.
  assertNoSystemdControlChars(instance.stateDir, 'WorkingDirectory');
  assertNoSystemdControlChars(instance.logPath, 'StandardOutput/StandardError path');
  assertNoSystemdControlChars(command.executable, 'ExecStart executable');
  command.args.forEach((arg, i) => assertNoSystemdControlChars(arg, `ExecStart argument[${i}]`));
  const mergedEnv = withForwardedMyelinDir({ ...command.env, ...envVars, ...instance.env }, env);
  assertNoSystemdEnvControlChars(mergedEnv);
  const envLines = systemdEnvironmentLines(mergedEnv);
  const unsetLines = buildServiceEnvUnsetLines({ os: 'linux' });
  const execStart = instance.engine === 'headroom_lite'
    ? renderSystemdExecStart([command.executable, ...command.args], systemdArgument)
    : renderSystemdExecStart([command.executable, ...command.args]);
  return `[Unit]
Description=${description} (${serviceId})
After=network.target

[Service]
ExecStart=${execStart}
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
  const {
    _isPortResponding = isPortResponding,
    _isUnitUnchanged = isUnitUnchanged,
    forceRestart = false,
    ...opts
  } = options;
  const { serviceId } = engineInstanceIdentity(instance);
  const content = validateSystemdUnit(generateEngineInstanceUnit({ instance, ...opts }));
  const p = engineInstanceUnitPath(instance);
  mkdirSync(instance.stateDir, { recursive: true });
  mkdirSync(join(homedir(), '.config', 'systemd', 'user'), { recursive: true });
  // Skip restart when unit file is unchanged and service is already active —
  // avoids the brief service gap during routine reinstalls.
  // forceRestart=true bypasses skip for callers that just overwrote a referenced
  // file (e.g. Python addon) at a stable path.
  if (!forceRestart && _isUnitUnchanged(p, content) && _isPortResponding(instance.port)) {
    return 'skipped';
  }
  writeFileSync(p, content, 'utf8');
  execSync('systemctl --user daemon-reload');
  execSync(`systemctl --user enable ${serviceId}.service`);
  execSync(`systemctl --user restart ${serviceId}.service`);
  return 'restarted';
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

export function generateMitmUnit({ mitmdumpBin, port, addonPath, args, envVars = {}, env = process.env }) {
  const execArgs = args ?? ['--listen-port', String(port), '-s', addonPath];
  const mergedEnv = withForwardedMyelinDir(envVars, env);
  assertNoSystemdEnvControlChars(mergedEnv);
  const envLines = systemdEnvironmentLines(mergedEnv);
  const unsetLines = buildServiceEnvUnsetLines({ os: 'linux' });
  const execStart = renderSystemdExecStart([mitmdumpBin, ...execArgs]);
  return `[Unit]
Description=Myelin mitmproxy LLM compression proxy
After=network.target myelin-headroom.service

[Service]
ExecStart=${execStart}
Restart=always
RestartSec=10
${unsetLines}
${envLines}

[Install]
WantedBy=default.target`;
}

export function unitPath() {
  return join(homedir(), '.config', 'systemd', 'user', 'myelin-compression.service');
}

export function copilotHeadroomUnitPath() {
  return join(homedir(), '.config', 'systemd', 'user', 'myelin-copilot-compression.service');
}

export function mitmUnitPath(home = homedir()) {
  return pathPosix.join(home, '.config', 'systemd', 'user', 'myelin-mitmproxy.service');
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

export function installMitmService({ mitmdumpBin, port, addonPath, envVars = {}, egressPort, home, env = process.env, _isPortResponding = isPortResponding, _isUnitUnchanged = isUnitUnchanged, forceRestart = false }) {
  const args = egressPort
    ? ['--mode', `regular@${port}`, '--mode', `regular@127.0.0.1:${egressPort}`, '-s', addonPath]
    : ['--listen-port', String(port), '-s', addonPath];
  const proxy = envVars.HTTPS_PROXY || envVars.https_proxy || '';
  if (proxy && !proxy.includes('127.0.0.1') && !proxy.includes('localhost')) args.push('--mode', `upstream:${proxy}`);
  const caBundle = envVars.SSL_CERT_FILE || envVars.REQUESTS_CA_BUNDLE ||
                   envVars.NODE_EXTRA_CA_CERTS || envVars.HEADROOM_CA_BUNDLE || '';
  if (caBundle) args.push('--set', `ssl_verify_upstream_trusted_ca=${caBundle}`);
  args.push('--ignore-hosts', String.raw`.*\.akamai\.com|.*\.corp\.akamai\.com|.*\.akamaized\.net|.*\.akamaihd\.net|api\.github\.com|.*\.github\.com|github\.com`);
  const content = validateSystemdUnit(generateMitmUnit({
    mitmdumpBin, port, addonPath, args,
    envVars: { ...(egressPort ? { MYELIN_EGRESS_PORT: String(egressPort) } : {}), ...envVars, PYTHONOPTIMIZE: '1' },
    env,
  }));
  const p = mitmUnitPath(home ?? homedir());
  mkdirSync(join(homedir(), '.config', 'systemd', 'user'), { recursive: true });
  // Skip restart when unit is unchanged and mitmproxy is already listening.
  // forceRestart=true bypasses the skip (e.g. when the installer knows it just
  // overwrote a referenced file such as the Python addon at a stable path).
  if (!forceRestart && _isUnitUnchanged(p, content) && _isPortResponding(port)) {
    return 'skipped';
  }
  writeFileSync(p, content, 'utf8');
  execSync('systemctl --user daemon-reload');
  execSync('systemctl --user enable myelin-mitmproxy.service');
  // `restart` is always correct: starts if stopped, cleanly restarts if running.
  execSync('systemctl --user restart myelin-mitmproxy.service');
  return 'restarted';
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
