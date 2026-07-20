import { writeFileSync, mkdirSync, existsSync, readFileSync, unlinkSync, renameSync, chmodSync } from 'node:fs';
import { join, posix as pathPosix, sep } from 'node:path';
import { homedir } from 'node:os';
import { execSync, execFileSync } from 'node:child_process';
import { buildServiceEnvUnsetLines, SERVER_FORBIDDEN_ENV } from './wrappers.mjs';
import { resolveHeadroomLiteEntrypoint } from './headroom-lite-command.mjs';
import { managedPaths, joinManaged, withForwardedMyelinDir } from '../shared/myelin-paths.mjs';
import { posixSingleQuote } from '../shared/shell-quote.mjs';

const LABEL      = 'com.myelin.compression';
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

function engineInstanceCommand(instance = {}, {
  headroomBin,
  headroomLiteBin,
  nodePath = process.execPath,
} = {}) {
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
      command: nodePath,
      args: [resolveHeadroomLiteEntrypoint(headroomLiteBin)],
      env: { HEADROOM_LITE_PORT: String(instance.port), HEADROOM_LITE_STATS_PATH: join(instance.stateDir, 'telemetry.json') },
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
    logPath: logPath ?? joinManaged(root, `${id}.log`),
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
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Write a plist safely: render to a `<path>.candidate`, validate it with
 * `plutil -lint` (via an injected exec impl so unit tests never shell out), and
 * ONLY on success atomically rename the candidate over the destination. On
 * failure the candidate is removed and the error is thrown WITHOUT touching the
 * existing (healthy) plist — so the installer never boots out a working job and
 * then fails to bootstrap a broken replacement.
 */
export function writeValidatedPlist({
  path,
  content,
  writeFileSyncImpl = writeFileSync,
  renameSyncImpl = renameSync,
  unlinkSyncImpl = unlinkSync,
  execFileSyncImpl = execFileSync,
  plutilPath = 'plutil',
} = {}) {
  const candidate = `${path}.candidate`;
  writeFileSyncImpl(candidate, content, 'utf8');
  try {
    execFileSyncImpl(plutilPath, ['-lint', candidate], { stdio: 'ignore' });
  } catch (err) {
    try { unlinkSyncImpl(candidate); } catch {}
    const detail = String(err?.message ?? err).split('\n')[0];
    throw new Error(`Refusing to install invalid plist at ${path}: plutil -lint failed: ${detail}`);
  }
  renameSyncImpl(candidate, path);
  return path;
}

/**
 * Return true when `port` has a process actively listening on 127.0.0.1.
 * Used to decide whether a service restart is necessary during install.
 * Injected `impl` allows unit tests to override without shelling out.
 */
export function isPortResponding(port, { execFileSyncImpl = execFileSync, attempts = 3 } = {}) {
  if (port == null) return false;
  // Retry a few times before declaring the port down. A single `nc -z -w 1`
  // probe false-negatives against a busy-but-healthy proxy under streaming
  // load, which used to trigger a needless restart of a working mitmproxy
  // (brief ECONNREFUSED / os error 61). Any success => responding. (The watchdog
  // bash probe is hardened with the same retry + a live-PID guard in
  // generateLaunchdWatchdogScript.)
  for (let i = 0; i < Math.max(1, attempts); i++) {
    try {
      execFileSyncImpl('nc', ['-z', '-w', i === 0 ? '1' : '2', '127.0.0.1', String(port)], { stdio: 'ignore' });
      return true;
    } catch {
      // try again
    }
  }
  return false;
}

/**
 * True when `plistPath` lives under the REAL user's `~/Library/LaunchAgents`
 * (the only place a gui-domain launchd agent legitimately belongs).
 *
 * This is an ALLOWLIST — inverting the earlier "is it under the temp dir?"
 * blocklist, which was fragile: it missed `/tmp` / `/private/tmp`, broke when
 * `$TMPDIR` was set to `/` or `$HOME`, and depended on os.tmpdir() matching the
 * exact temp root a test used. The allowlist is robust regardless of $TMPDIR:
 * a test's fake HOME (temp dir, /tmp, anywhere) is never under the real
 * ~/Library/LaunchAgents, so its plist is refused; a real production plist at
 * <realHome>/Library/LaunchAgents/... is always accepted.
 *
 * `home` MUST be the real os.homedir() (never a caller-supplied home, which a
 * test controls) — that is what makes the guard un-bypassable by a fake HOME.
 */
export function isManagedLaunchAgentPath(plistPath, home = homedir()) {
  if (!plistPath || typeof plistPath !== 'string' || !home) return false;
  const laDir = join(home, 'Library', 'LaunchAgents');
  return plistPath !== laDir && plistPath.startsWith(laDir + sep);
}

/**
 * Robustly replace a launchd agent: bootout the old registration, then
 * bootstrap the new plist with retries so a bootout/bootstrap race can never
 * leave the service DOWN. The previous `bootout → sleep 1 → bootstrap` sequence
 * failed with EIO ("Bootstrap failed: 5: Input/output error") whenever bootout
 * had not finished within the fixed 1s, and the service stayed down until the
 * next `myelin update` happened to re-bootstrap it.
 *
 * Safety: refuses to bootstrap any plist that is NOT under the real user's
 * ~/Library/LaunchAgents (unless `allowTmpBootstrap` is set — tests only). This
 * makes it impossible for a test with a fake temp HOME to register a real
 * `com.myelin.*` label into the real gui domain.
 *
 * All shell-outs go through the injectable `execSyncImpl`, so unit tests never
 * touch real launchd.
 */
export function bootReplaceLaunchdService({
  uid,
  label,
  plistPath,
  home = homedir(),
  execSyncImpl = execSync,
  sleepImpl,
  maxTries = 5,
  allowTmpBootstrap = false,
  isManagedPathImpl = isManagedLaunchAgentPath,
} = {}) {
  if (!allowTmpBootstrap && !isManagedPathImpl(plistPath, home)) {
    throw new Error(`refusing to bootstrap launchd label ${label} from a non-managed plist path (must be under ${join(home, 'Library', 'LaunchAgents')}): ${plistPath}`);
  }
  const sleep = sleepImpl ?? ((ms) => { try { execSyncImpl(`sleep ${Math.max(0, ms) / 1000}`); } catch {} });
  const bootout = () => { try { execSyncImpl(`launchctl bootout gui/${uid}/${label}`, { stdio: 'ignore' }); } catch {} };
  bootout();
  // Clear any stale disabled-override so bootstrap doesn't fail with EIO (code 5).
  // Safe to call even when the service is already enabled — it's idempotent.
  try { execSyncImpl(`launchctl enable gui/${uid}/${label}`, { stdio: 'ignore' }); } catch {}
  let lastErr = null;
  for (let i = 0; i < Math.max(1, maxTries); i++) {
    // First wait preserves the original ~1s settle; later waits are shorter.
    sleep(i === 0 ? 1000 : 500);
    try {
      execSyncImpl(`launchctl bootstrap gui/${uid} ${plistPath}`);
      return true;
    } catch (e) {
      lastErr = e;
      if (i < maxTries - 1) bootout();
    }
  }
  throw lastErr ?? new Error(`launchctl bootstrap failed for ${label}`);
}

/**
 * Return true when the file at `path` already contains exactly `content`.
 * A missing file returns false (restart needed).
 */
export function isPlistUnchanged(path, content, { readFileSyncImpl = readFileSync, existsSyncImpl = existsSync } = {}) {
  if (!existsSyncImpl(path)) return false;
  try {
    return readFileSyncImpl(path, 'utf8') === content;
  } catch {
    return false;
  }
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
    .map(([k, v]) => `        <key>${xmlEscape(k)}</key>\n        <string>${xmlEscape(v)}</string>`)
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
    <string>${xmlEscape(label)}</string>
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
    <string>${xmlEscape(logPath ?? '/tmp/myelin.log')}</string>
    <key>StandardErrorPath</key>
    <string>${xmlEscape(logPath ?? '/tmp/myelin.log')}</string>${workingDirEntry}
</dict>
</plist>`;
}

export function generateEngineInstancePlist({ instance, envVars = {}, env = process.env, ...options }) {
  const { label } = engineInstanceIdentity(instance);
  const command = engineInstanceCommand(instance, options);
  return generateGenericPlist({
    label,
    command: command.command,
    args: command.args,
    envVars: withForwardedMyelinDir({ ...command.env, ...envVars, ...instance.env }, env),
    logPath: instance.logPath,
    workingDirectory: instance.stateDir,
  });
}

export function engineInstancePlistPath(instance) {
  const { label } = engineInstanceIdentity(instance);
  return join(homedir(), 'Library', 'LaunchAgents', `${label}.plist`);
}

export function installEngineInstance(instance, options = {}) {
  const {
    _isPortResponding = isPortResponding,
    _isPlistUnchanged = isPlistUnchanged,
    execSyncImpl = execSync,
    forceRestart = false,
    ...opts
  } = options;
  const { label } = engineInstanceIdentity(instance);
  const p = engineInstancePlistPath(instance);
  const content = generateEngineInstancePlist({ instance, ...opts });
  mkdirSync(instance.stateDir, { recursive: true });
  mkdirSync(join(homedir(), 'Library', 'LaunchAgents'), { recursive: true });
  // Skip restart entirely when config is unchanged and the service is already
  // responding — avoids the ~5s bootout/bootstrap gap that causes Copilot CLI
  // ECONNREFUSED during routine reinstalls.
  // forceRestart=true bypasses the skip (e.g. when the installer knows it just
  // overwrote a referenced file such as the Python addon at a stable path).
  if (!forceRestart && _isPlistUnchanged(p, content) && _isPortResponding(instance.port)) {
    return 'skipped';
  }
  // Validate + atomically replace BEFORE booting out the running job, so an
  // invalid plist (bad XML from a `&`/`<` path) can never leave the host with a
  // booted-out job and no working replacement.
  writeValidatedPlist({ path: p, content });
  const uid = process.getuid?.() ?? execSyncImpl('id -u').toString().trim();
  bootReplaceLaunchdService({ uid, label, plistPath: p, execSyncImpl });
  return 'restarted';
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
export function installMitmService({ mitmdumpBin, port, addonPath, envVars = {}, logPath, home, env = process.env, upstreamProxy, egressPort, _isPortResponding = isPortResponding, _isPlistUnchanged = isPlistUnchanged, execSyncImpl = execSync, forceRestart = false }) {
  const p = mitmPlistPath(home ?? homedir());
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
    // Bare github.com (HTTPS git operations) — .*\.github\.com only matches
    // subdomains; the bare domain was missing, causing large git pack responses
    // (~1.8 MB) to flow through mitmproxy and crash it.
    String.raw`github\.com`,
  ].join('|');
  args.push('--ignore-hosts', IGNORE_HOSTS);

  const content = generateGenericPlist({
    label: MITM_LABEL,
    command: mitmdumpBin,
    args,
    envVars: withForwardedMyelinDir({
      MYELIN_HEADROOM_PORT: String(envVars.HEADROOM_PORT ?? 8787),
      ...(egressPort ? { MYELIN_EGRESS_PORT: String(egressPort) } : {}),
      ...envVars,
      // PYTHONOPTIMIZE=1 disables Python assert statements (__debug__=False).
      // mitmproxy's @expect decorator is guarded by `if __debug__ is True:` —
      // without this flag it raises AssertionError when ResponseProtocolError
      // arrives during response streaming (incomplete chunked read from the API
      // mid-stream), crashing the process with no traceback. Placed last so it
      // cannot be overridden by caller envVars.
      PYTHONOPTIMIZE: '1',
      ...(egressPort ? { MYELIN_EGRESS_PORT: String(egressPort) } : {}),
      ...envVars,
    }, env),
    logPath: logPath ?? joinManaged(managedPaths({ home: home ?? homedir(), env }).root, 'mitmproxy.log'),
  });
  mkdirSync(join(homedir(), 'Library', 'LaunchAgents'), { recursive: true });
  // Skip restart when config is unchanged and mitmproxy is already listening —
  // avoids the ~5s bootout/bootstrap gap that causes Copilot CLI ECONNREFUSED.
  // forceRestart=true bypasses skip for callers that just overwrote a referenced
  // file (e.g. Python addon) at a stable path.
  if (!forceRestart && _isPlistUnchanged(p, content) && _isPortResponding(port)) {
    return 'skipped';
  }
  writeValidatedPlist({ path: p, content });
  const uid = process.getuid?.() ?? execSyncImpl('id -u').toString().trim();
  bootReplaceLaunchdService({ uid, label: MITM_LABEL, plistPath: p, execSyncImpl });
  return 'restarted';
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
export function generateLaunchdWatchdogScript({ home, env = process.env, headroomPort, mitmPort, copilotHeadroomPort, egressPort } = {}) {
  home = home ?? homedir();
  const la = join(home, 'Library', 'LaunchAgents');
  const watchdogLog = joinManaged(managedPaths({ home, env }).root, 'watchdog.log');
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
  # Retry the probe before declaring the port down — a single nc -z probe
  # false-negatives against a busy-but-healthy proxy under streaming load,
  # which used to make the watchdog needlessly tear down a working service.
  local i
  for i in 1 2 3; do
    if nc -z -w 2 127.0.0.1 "$port" 2>/dev/null; then return 0; fi
    sleep 1
  done
  local plist
  plist=$(ls "$LA"/$glob 2>/dev/null | grep -v '\.bak' | head -1)
  if [ -z "$plist" ]; then return 0; fi
  local label
  label=$(basename "$plist" .plist)
  # NEVER kill a service launchd still reports running with a live PID: the
  # port can transiently fail to answer while the process is perfectly healthy.
  # Only revive a genuinely dropped job.
  if launchctl list "$label" 2>/dev/null | grep -qE '"PID"[[:space:]]*=[[:space:]]*[0-9]+'; then
    return 0
  fi
  # Robust re-bootstrap: retry so a bootout/bootstrap EIO ("error 5") race can
  # never leave the service DOWN (the old fixed sleep + single bootstrap did).
  local t
  for t in 1 2 3 4 5; do
    launchctl bootout "gui/$UID_N/$label" 2>/dev/null
    launchctl enable "gui/$UID_N/$label" 2>/dev/null
    sleep 1
    if launchctl bootstrap "gui/$UID_N" "$plist" 2>/dev/null; then
      echo "[watchdog] $(date '+%Y-%m-%d %H:%M:%S') revived $name ($label)" >> ${posixSingleQuote(watchdogLog)}
      return 0
    fi
  done
  echo "[watchdog] $(date '+%Y-%m-%d %H:%M:%S') FAILED to revive $name ($label) after retries" >> ${posixSingleQuote(watchdogLog)}
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
export function installWatchdog({ home, env = process.env, headroomPort, mitmPort, copilotHeadroomPort, egressPort, execSyncImpl = execSync } = {}) {
  home = home ?? homedir();
  const root = managedPaths({ home, env }).root;
  const binDir = joinManaged(root, 'bin');
  mkdirSync(binDir, { recursive: true });
  const scriptPath = joinManaged(binDir, 'watchdog.sh');
  const la = join(home, 'Library', 'LaunchAgents');
  const watchdogLog = joinManaged(root, 'watchdog.log');

  const script = generateLaunchdWatchdogScript({ home, env, headroomPort, mitmPort, copilotHeadroomPort, egressPort });
  writeFileSync(scriptPath, script, 'utf8');
  chmodSync(scriptPath, 0o755);

  const plistContent = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${xmlEscape(WATCHDOG_LABEL)}</string>
    <key>ProgramArguments</key>
    <array>
        <string>/bin/bash</string>
        <string>${xmlEscape(scriptPath)}</string>
    </array>
    <key>StartInterval</key>
    <integer>90</integer>
    <key>RunAtLoad</key>
    <true/>
    <key>StandardOutPath</key>
    <string>${xmlEscape(watchdogLog)}</string>
    <key>StandardErrorPath</key>
    <string>${xmlEscape(watchdogLog)}</string>
</dict>
</plist>`;
  const plistPathW = join(la, `${WATCHDOG_LABEL}.plist`);
  mkdirSync(la, { recursive: true });
  writeValidatedPlist({ path: plistPathW, content: plistContent });
  const uid = process.getuid?.() ?? execSyncImpl('id -u').toString().trim();
  bootReplaceLaunchdService({ uid, label: WATCHDOG_LABEL, plistPath: plistPathW, execSyncImpl });
  return plistPathW;
}

export function serviceStatus() {
  return engineInstanceStatus(legacyEngineInstance({ role: 'primary' }));
}
