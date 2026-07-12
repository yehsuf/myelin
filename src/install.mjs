#!/usr/bin/env node
/**
 * Myelin — complete installer
 * Flags: --profile proxy|mcp|minimal  --index-tier light|default|full
 *        --no-headroom  --no-rtk  --copilot-only  --claude-only
 *        --check  --dry-run
 */
import { parseArgs } from 'node:util';
import { mkdirSync, existsSync, readFileSync, writeFileSync, copyFileSync, accessSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { createInterface as createRL } from 'node:readline';
import { buildCombinedCaCert } from './detect/combined-ca.mjs';
import { detectOS, detectShell, powerShellExecutable } from './detect/os.mjs';
import { detectAll, detectCopilotHud, detectRtk } from './detect/tools.mjs';
import { which } from './detect/which.mjs';
import { detectCorporateProxy, detectCaBundles, buildCorporateSslEnv } from './detect/proxy.mjs';
import { isPortFree, findFreePort } from './detect/port.mjs';
import { loadConfig, DEFAULT_CONFIG_PATH } from './config/reader.mjs';
import { resolveMitmCompression } from './config/compression-env.mjs';
import { writeConfig } from './config/writer.mjs';
import { DEFAULT_CONFIG, mergeDeep } from './config/schema.mjs';
import { buildServiceEnginePlan, selectedEnginePort } from './config/engine-runtime.mjs';
import { applyDisableSerenaDashboardAutoOpen } from './service/serena-config.mjs';
import {
  installTokenOptimizerForCopilot,
  hardenCopilotTokenOptimizerHook,
  tokenOptimizerClaudeCodeInstructions,
  tokenOptimizerLicenseNotice,
} from './service/token-optimizer.mjs';
import { renderManagedBlock } from './config/instruction-snippets.mjs';
import { writeManagedSection } from './config/managed-section.mjs';
import { ensureUv } from './tools/uv.mjs';
import { installHeadroom, waitForHeadroom, headroomBinPath } from './tools/headroom.mjs';
import { installRtk, getRtkVersionWarning, runRtkInit, ensureSafeRtkCopilotHook } from './tools/rtk.mjs';
import { installService, installMitmService, installCopilotHeadroomService } from './service/index.mjs';
import { linkGlobalBin } from './service/npmlink.mjs';
import { defaultWindowsHome, normalizeWindowsFilesystemPath, setUserEnvVars } from './service/windows.mjs';
import { buildCopilotWrapper, buildClaudeWrapper } from './service/wrappers.mjs';
import { fileURLToPath } from 'node:url';
import { execSync, spawn } from 'node:child_process';

// helpers
const ok   = m => console.log(`  \u2713 ${m}`);
const skip = m => console.log(`  \u00b7 ${m}`);
const warn = m => console.warn(`  \u26a0 ${m}`);
const step = m => console.log(`\n${m}`);

function backup(path) {
  if (existsSync(path)) {
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    copyFileSync(path, `${path}.bak.${ts}`);
  }
}

function mergeDeepPlain(base, override) {
  if (typeof base !== 'object' || base === null) return override;
  if (typeof override !== 'object' || override === null) return override;
  const r = { ...base };
  for (const k of Object.keys(override)) {
    r[k] = (typeof override[k] === 'object' && !Array.isArray(override[k]) && override[k] !== null)
      ? mergeDeepPlain(base[k] ?? {}, override[k]) : override[k];
  }
  return r;
}

function mergeJsonFile(path, updates, createIfMissing = {}) {
  const current = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : createIfMissing;
  backup(path);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, JSON.stringify(mergeDeepPlain(current, updates), null, 2), 'utf8');
}

function isVersionAtLeast(version, minimum) {
  const parse = (v) => v.replace(/^v/i, '').split('.').map(n => parseInt(n, 10) || 0);
  const a = parse(version ?? '0.0.0');
  const b = parse(minimum);
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const left = a[i] ?? 0;
    const right = b[i] ?? 0;
    if (left > right) return true;
    if (left < right) return false;
  }
  return true;
}

export function buildManagedHeadroomRunKeyCleanupCommand({ powershellExe = powerShellExecutable() } = {}) {
  return `${powershellExe} -NoProfile -Command "Remove-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run' -Name 'MyelinHeadroom' -ErrorAction SilentlyContinue"`;
}

export async function removeManagedHeadroomRegistration({
  os,
  winManager,
  home,
  headroomPort = 8787,
  warnFn = warn,
  okFn = ok,
  execSyncImpl = execSync,
  powershellExe = powerShellExecutable(),
  stopManagedHeadroomProcessImpl,
} = {}) {
  if (os === 'darwin') {
    try {
      const { plistPath } = await import('./service/launchd.mjs');
      const uid = process.getuid?.() ?? execSync('id -u').toString().trim();
      try { execSync(`launchctl bootout gui/${uid}/com.myelin.headroom`, { stdio: 'ignore' }); } catch {}
      const path = plistPath();
      if (existsSync(path)) unlinkSync(path);
      okFn('obsolete headroom launchd service removed');
    } catch (e) {
      warnFn(`obsolete headroom cleanup failed: ${e.message}`);
    }
    return;
  }

  if (os === 'linux') {
    try {
      const { unitPath } = await import('./service/systemd.mjs');
      try { execSync('systemctl --user disable --now myelin-headroom.service', { stdio: 'pipe' }); } catch {}
      const path = unitPath();
      if (existsSync(path)) unlinkSync(path);
      try { execSync('systemctl --user daemon-reload', { stdio: 'pipe' }); } catch {}
      okFn('obsolete headroom systemd service removed');
    } catch (e) {
      warnFn(`obsolete headroom cleanup failed: ${e.message}`);
    }
    return;
  }

  if (winManager === 'winsw') {
    try {
      const { HEADROOM_SERVICE_ID, uninstallWinswService } = await import('./service/windows.mjs');
      uninstallWinswService({ id: HEADROOM_SERVICE_ID });
      okFn('obsolete headroom WinSW service removed');
    } catch (e) {
      warnFn(`obsolete headroom cleanup failed: ${e.message}`);
    }
    return;
  }

  try {
    try {
      const stopManagedHeadroomProcess = stopManagedHeadroomProcessImpl
        ?? (await import('./service/windows.mjs')).stopManagedHeadroomProcess;
      stopManagedHeadroomProcess({ port: headroomPort, home, execSyncImpl, powershellExe });
    } catch {}
    execSyncImpl(buildManagedHeadroomRunKeyCleanupCommand({ powershellExe }), { stdio: 'pipe' });
    okFn('obsolete headroom Run key removed');
  } catch (e) {
    warnFn(`obsolete headroom cleanup failed: ${e.message}`);
  }
}

export async function managedHeadroomRegistrationStatus({ os, winManager, home, headroomPort = 8787 } = {}) {
  if (os === 'darwin') {
    const { plistPath } = await import('./service/launchd.mjs');
    return { registered: existsSync(plistPath()) };
  }

  if (os === 'linux') {
    const { unitPath } = await import('./service/systemd.mjs');
    return { registered: existsSync(unitPath()) };
  }

  if (winManager === 'winsw') {
    const { HEADROOM_SERVICE_ID, winswServiceStatus } = await import('./service/windows.mjs');
    const status = winswServiceStatus({ id: HEADROOM_SERVICE_ID, home });
    return {
      registered: status.state !== 'Missing' && status.state !== 'NonExistent',
      status,
    };
  }

  const { headroomRunKeyStatus, isLegacyManagedHeadroomRunKeyValue } = await import('./service/windows.mjs');
  const status = headroomRunKeyStatus();
  return {
    ...status,
    registered: status.registered && !isLegacyManagedHeadroomRunKeyValue({ port: headroomPort, runKeyValue: status.raw }),
    needsMigration: isLegacyManagedHeadroomRunKeyValue({ port: headroomPort, runKeyValue: status.raw }),
  };
}

export async function ensureManagedHeadroomService({
  os = detectOS(),
  winManager = 'registry',
  home,
  headroomBin,
  port,
  envVars = {},
  interceptToolResults,
  logFn = console.log,
  okFn = ok,
  warnFn = warn,
  installServiceImpl = installService,
  waitForHeadroomImpl = waitForHeadroom,
  registrationStatusImpl = managedHeadroomRegistrationStatus,
  stopHealthyProcessImpl = stopHealthyProcessForManagedInstall,
} = {}) {
  const registration = await registrationStatusImpl({ os, winManager, home, headroomPort: port });
  const alreadyHealthy = await waitForHeadroomImpl(port, 1500).catch(() => false);
  const shouldInstall = !alreadyHealthy || !registration?.registered;

  if (shouldInstall) {
    if (alreadyHealthy && !registration?.registered) {
      await stopHealthyProcessImpl({ os, winManager, home, port, headroomBin });
    }
    await installServiceImpl({
      headroomBin,
      port,
      envVars,
      home,
      interceptToolResults,
      logPath: join(home, '.myelin', 'headroom.log'),
      manager: winManager,
    });
    okFn(`service registered (port ${port})`);
    logFn('  Waiting for proxy...');
    const healthy = await waitForHeadroomImpl(port, os === 'windows' ? 15000 : 10000);
    healthy ? okFn(`proxy healthy on :${port}`) : warnFn('no response — run: myelin diagnose');
    return { installed: true, alreadyHealthy, registeredBefore: !!registration?.registered, healthy };
  }

  okFn(`service registered (port ${port})`);
  okFn(`proxy healthy on :${port}`);
  return { installed: false, alreadyHealthy: true, registeredBefore: true, healthy: true };
}

export async function applyServiceEngineInstallPlan({
  enginePlan,
  os = detectOS(),
  cfg = {},
  winManager = cfg?.proxy?.windows_service?.manager ?? 'registry',
  home,
  headroomBin,
  port,
  envVars = {},
  interceptToolResults = cfg?.proxy?.headroom?.intercept_tool_results ?? true,
  warnFn = warn,
  logFn = console.log,
  okFn = ok,
  ensureManagedHeadroomServiceImpl = ensureManagedHeadroomService,
  removeManagedHeadroomRegistrationImpl = removeManagedHeadroomRegistration,
  stopObsoleteEngineImpl,
  detectToolImpl,
  restartHeadroomLiteImpl,
} = {}) {
  const resolvedPlan = { ...(enginePlan ?? buildServiceEnginePlan(cfg)) };
  let persistHeadroomFallback = false;

  if (resolvedPlan.selectedEngine === 'headroom_lite') {
    const detectTool = detectToolImpl ?? (await import('./detect/tools.mjs')).detectTool;
    const headroomLite = await detectTool('headroom-lite', '--version');
    if (!headroomLite.installed) {
      warnFn('headroom-lite selected but not installed — keeping managed headroom until `myelin restart` can start headroom-lite');
      resolvedPlan.selectedEngine = 'headroom';
      resolvedPlan.selectedPort = port;
      resolvedPlan.shouldRunManagedHeadroom = true;
      resolvedPlan.shouldRemoveManagedHeadroom = false;
      persistHeadroomFallback = true;
    } else {
      const restartHeadroomLite = restartHeadroomLiteImpl ?? (await import('./cli/restart.mjs')).restartHeadroomLite;
      const healthy = await restartHeadroomLite(resolvedPlan.selectedPort, os, cfg);
      if (!healthy) {
        warnFn('headroom-lite selected but not healthy after start — keeping managed headroom until a later restart succeeds');
        resolvedPlan.selectedEngine = 'headroom';
        resolvedPlan.selectedPort = port;
        resolvedPlan.shouldRunManagedHeadroom = true;
        resolvedPlan.shouldRemoveManagedHeadroom = false;
        persistHeadroomFallback = true;
      }
    }
  }

  if (resolvedPlan.shouldRunManagedHeadroom) {
    const stopObsoleteEngine = stopObsoleteEngineImpl ?? (await import('./cli/restart.mjs')).stopObsoleteEngine;
    await stopObsoleteEngine({
      engine: 'headroom_lite',
      os,
      cfg,
      winManager,
      home,
      warn: warnFn,
    });
    await ensureManagedHeadroomServiceImpl({
      os,
      winManager,
      home,
      headroomBin,
      port,
      envVars,
      interceptToolResults,
      logFn,
      okFn,
      warnFn,
    });
  } else if (resolvedPlan.shouldRemoveManagedHeadroom) {
    await removeManagedHeadroomRegistrationImpl({ os, winManager, home, headroomPort: resolvedPlan.headroomPort });
  }

  return {
    enginePlan: resolvedPlan,
    persistHeadroomFallback,
    selectedInstallEngine: resolvedPlan.selectedEngine,
    selectedProxyPort: resolvedPlan.selectedPort,
  };
}

async function stopHealthyProcessForManagedInstall({ os, home, port, headroomBin }) {
  if (os === 'windows') {
    try {
      const { stopManagedHeadroomProcess, stopHeadroomProcessByExecutablePath } = await import('./service/windows.mjs');
      stopManagedHeadroomProcess({ port, home });
      stopHeadroomProcessByExecutablePath({ port, executablePath: headroomBin });
    } catch {}
    return;
  }

  try {
    const command = `pids=$(lsof -tiTCP:${port} -sTCP:LISTEN 2>/dev/null); for pid in $pids; do cmd=$(ps -p "$pid" -o command=); case "$cmd" in *"${headroomBin}"*"proxy --port ${port}"*) kill -9 "$pid" ;; esac; done`;
    execSync(command, { stdio: 'pipe', shell: '/bin/bash' });
  } catch {}
}

async function detectHeadroomFork() {
  // Kept for detecting already-installed local dev builds — uses them as-is, doesn't prefer them
  const candidates = [
    join(homedir(), 'Work', 'headroom', '.venv13', 'bin', 'headroom'),
    join(homedir(), 'Work', 'headroom', '.venv', 'bin', 'headroom'),
  ];
  for (const p of candidates) {
    if (existsSync(p)) return { path: p, source: 'local-dev' };
  }
  return null;
}

function shellProfilePath(os, shell) {
  if (os === 'windows') {
    // Documents\WindowsPowerShell is Controlled Folder Access protected on many corp machines.
    // Use APPDATA instead and dot-source it from the real $PROFILE.
    const appData = process.env.APPDATA || join(homedir(), 'AppData', 'Roaming');
    return join(appData, 'Microsoft', 'Windows', 'PowerShell', 'v1.0', 'profile.ps1');
  }
  if (shell.includes('zsh'))  return join(homedir(), '.zshrc');
  if (shell.includes('bash')) return join(homedir(), '.bashrc');
  if (shell.includes('fish')) return join(homedir(), '.config', 'fish', 'config.fish');
  return join(homedir(), '.profile');
}

/**
 * Make `myelin`/`_copilot` auto-load in every new PowerShell window without ever
 * touching $PROFILE. PowerShell's real profile files always live under
 * Documents\WindowsPowerShell(\...), which Windows Defender's Controlled Folder
 * Access blocks on many corp machines — confirmed live: icacls shows full NTFS
 * control for the user, yet New-Item/Add-Content into that folder silently fail
 * with no thrown error (so a naive execSync-based approach reports false success).
 *
 * Instead, this drops a small PowerShell module under %APPDATA% (not CFA-protected)
 * that dot-sources the managed profile content, and persists that module's parent
 * directory on the user's PSModulePath via the registry (an env var write, not a
 * filesystem write, so CFA doesn't apply). PowerShell auto-imports a module the
 * first time an unrecognized command name it exports is typed, so `myelin` and
 * `_copilot` work in any new session with zero Documents access required.
 */
function installWindowsAutoloadModule(appData, profilePath) {
  const moduleDir = join(appData, 'Microsoft', 'Windows', 'PowerShell', 'Modules', 'MyelinAutoload');
  mkdirSync(moduleDir, { recursive: true });
  const psm1 = join(moduleDir, 'MyelinAutoload.psm1');
  writeFileSync(psm1, `. "${profilePath}"\nExport-ModuleMember -Function myelin, _copilot, _claude\n`, 'utf8');
  writeFileSync(join(moduleDir, 'MyelinAutoload.psd1'),
    `@{\n  ModuleVersion = '1.0'\n  RootModule = 'MyelinAutoload.psm1'\n  FunctionsToExport = @('myelin','_copilot','_claude')\n}\n`, 'utf8');

  const modulesParent = join(appData, 'Microsoft', 'Windows', 'PowerShell', 'Modules');
  const tmp = join(tmpdir(), `myelin-psmodulepath-${Date.now()}.ps1`);
  writeFileSync(tmp, `
$existing = [Environment]::GetEnvironmentVariable('PSModulePath', 'User')
$target = '${modulesParent}'
if (-not $existing) { $existing = '' }
if ($existing -notlike "*$target*") {
  $new = if ($existing) { "$target;$existing" } else { $target }
  [Environment]::SetEnvironmentVariable('PSModulePath', $new, 'User')
}
`, 'utf8');
  try {
    execSync(`powershell -ExecutionPolicy Bypass -File "${tmp}"`, { stdio: 'pipe' });
    return existsSync(psm1);
  } catch {
    return false;
  } finally {
    try { unlinkSync(tmp); } catch {}
  }
}

function printStateTable(tools, caBundles, proxy) {
  console.log('\nCurrent State\n' + '─'.repeat(60));
  for (const [name, r] of Object.entries(tools)) {
    const icon = r.installed ? '\u2713' : '\u2717';
    console.log(`  ${icon} ${name.padEnd(14)} ${r.installed ? r.version : 'not installed'}`);
  }
  if (caBundles.length) console.log(`  CA bundles:     ${caBundles.map(b => b.source).join(', ')}`);
  if (proxy) console.log(`  Upstream proxy: ${proxy}`);
  console.log('─'.repeat(60) + '\n');
}

/**
 * Install mitmproxy CA into all PEM bundles referenced by env vars.
 * Detects locations from NODE_EXTRA_CA_CERTS, SSL_CERT_FILE, REQUESTS_CA_BUNDLE,
 * HEADROOM_CA_BUNDLE, GIT_SSL_CAINFO, CURL_CA_BUNDLE. Prompts user per file.
 * Creates ~/.myelin/ca-bundle.pem if none exists.
 *
 * Interactive: shows exact file path and asks Y/n for each.
 */
async function installMitmproxyCA(home, interactive = true) {
  const mitmCaPath = join(home, '.mitmproxy', 'mitmproxy-ca-cert.pem');
  if (!existsSync(mitmCaPath)) {
    skip('mitmproxy CA not found (run: mitmdump --listen-port 18899 briefly to generate)');
    return;
  }
  const mitmCert = readFileSync(mitmCaPath, 'utf8');
  const mitmMarker = 'CN=mitmproxy';

  // --- 1. Discover all CA-related paths from environment ---
  const envVars = ['NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'REQUESTS_CA_BUNDLE',
                   'HEADROOM_CA_BUNDLE', 'GIT_SSL_CAINFO', 'CURL_CA_BUNDLE'];
  const discovered = new Map(); // path → { writable, isPemBundle }

  for (const v of envVars) {
    const p = process.env[v];
    if (!p || !existsSync(p) || discovered.has(p)) continue;
    // Check if it's a PEM bundle (multiple certs) vs single cert
    let content = '';
    try { content = readFileSync(p, 'utf8'); } catch { continue; }
    const certCount = (content.match(/-----BEGIN CERTIFICATE-----/g) || []).length;
    if (certCount < 1) continue; // not a PEM file at all
    const isPemBundle = certCount > 1;
    // Check writability by attempting a test write
    let writable = false;
    try { accessSync(p, 2 /* W_OK */); writable = true; } catch {}
    discovered.set(p, { writable, isPemBundle, content });
  }

  // --- 2. Always rebuild our own bundle (fresh system content + mitmproxy CA) ---
  const ourBundle = join(home, '.myelin', 'ca-bundle.pem');
  mkdirSync(join(home, '.myelin'), { recursive: true });

  // Seed from: read-only discovered files + well-known system paths
  let sysCerts = '';
  const seedPaths = [
    ...[...discovered.entries()].filter(([, v]) => !v.writable).map(([p]) => p),
    '/etc/ssl/certs/ca-certificates.crt',
    '/etc/pki/tls/certs/ca-bundle.crt',
    '/etc/ssl/ca-bundle.pem',
    '/etc/ssl/cert.pem',
  ];
  for (const p of seedPaths) {
    if (existsSync(p)) {
      try { sysCerts += readFileSync(p, 'utf8') + '\n'; } catch {}
    }
  }
  if (!sysCerts && process.platform === 'darwin') {
    try { sysCerts = execSync('security find-certificate -a -p /Library/Keychains/SystemRootCertificates.keychain 2>/dev/null', { shell: true, stdio: 'pipe' }).toString(); } catch {}
  }
  // Corporate/MDM-installed interception CAs (e.g. NetFree) live in the
  // general System keychain and/or the user's login keychain — NOT in
  // SystemRootCertificates.keychain (Apple's built-in roots only). Must
  // always be queried (not gated behind "sysCerts is empty"), since on
  // macOS /etc/ssl/cert.pem often already exists and would otherwise skip
  // this entirely, silently omitting the one CA that actually matters for
  // TLS interception on this network. Missing it breaks any tool (pip,
  // gem, serena/semble's downloads, etc.) that does verify=<this file>
  // instead of trusting the OS keychain the way curl/Safari do.
  //
  // NOTE: `security find-certificate -a -p <keychain>` without a `-c` name
  // filter does NOT reliably enumerate every cert in the keychain on this
  // system (empirically confirmed: returns a partial subset, silently
  // missing entries that ARE found when searched by name) — so we also
  // explicitly search by the common names of known corporate TLS
  // interception products, which is the only reliable way to find them.
  if (process.platform === 'darwin') {
    const KEYCHAINS = [
      '/Library/Keychains/System.keychain',
      join(home, 'Library', 'Keychains', 'login.keychain-db'),
    ];
    const KNOWN_INTERCEPTOR_NAMES = ['NetFree', 'Zscaler', 'Blue Coat', 'Bluecoat', 'Forcepoint', 'Netskope', 'Menlo Security', 'Palo Alto', 'Cisco Umbrella'];
    for (const kc of KEYCHAINS) {
      // Best-effort full dump first (may already catch some)
      try {
        const certs = execSync(`security find-certificate -a -p "${kc}" 2>/dev/null`, { shell: true, stdio: 'pipe' }).toString();
        if (certs.trim()) sysCerts += '\n' + certs;
      } catch {}
      // Reliable targeted search for known interceptor CA names. Duplicates
      // (if the dump above already had them) are harmless in a CA bundle —
      // no need to dedup, and a naive text-prefix dedup check is unreliable
      // since unrelated certs commonly share the same leading PEM header
      // bytes, causing false-positive "already present" skips.
      for (const name of KNOWN_INTERCEPTOR_NAMES) {
        try {
          const certs = execSync(`security find-certificate -a -c "${name}" -p "${kc}" 2>/dev/null`, { shell: true, stdio: 'pipe' }).toString();
          if (certs.trim()) sysCerts += '\n' + certs;
        } catch {}
      }
    }
  }
  // Strip old mitmproxy CA entry, re-add fresh
  const withoutMitm = sysCerts.replace(/\n?# mitmproxy CA[\s\S]*?-----END CERTIFICATE-----\n?/g, '');
  writeFileSync(ourBundle,
    (withoutMitm || '') + '\n# mitmproxy CA (Myelin Copilot interception)\n' + mitmCert + '\n', 'utf8');
  ok(`ca-bundle.pem rebuilt from system CAs + mitmproxy CA`);
  discovered.set(ourBundle, { writable: true, isPemBundle: true, content: readFileSync(ourBundle, 'utf8') });

  // --- 3. For writable PEM bundles: offer to append mitmproxy CA ---
  for (const [pemPath, { writable, isPemBundle, content }] of discovered) {
    if (!writable || !isPemBundle) continue;
    if (content.includes(mitmMarker)) { skip(`${pemPath} — already trusts mitmproxy CA`); continue; }

    if (interactive) {
      const answer = await promptYN(`Add mitmproxy CA to ${pemPath}? [Y/n]: `);
      if (!answer) { skip(`${pemPath} — skipped`); continue; }
    }
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    try { copyFileSync(pemPath, `${pemPath}.bak.${ts}`); } catch {}
    writeFileSync(pemPath,
      content + '\n# mitmproxy CA (Myelin Copilot interception)\n' + mitmCert + '\n', 'utf8');
    ok(`${pemPath} — added mitmproxy CA`);
  }

  // --- 4. Report read-only bundles (inform user, suggest elevation) ---
  const readOnlyBundles = [...discovered.entries()].filter(([p, v]) => !v.writable && v.isPemBundle && p !== ourBundle);
  for (const [p] of readOnlyBundles) {
    skip(`${p} — read-only, content merged into ca-bundle.pem (to add directly: run installer as admin)`);
  }
}

// Shared readline instance — created once, reused across all prompts.
// Auto-accepts (returns true) when stdin is not a TTY or --yes flag is set.
let _rl = null;

async function promptYN(question) {
  if (!process.stdin.isTTY || process.argv.includes('--yes') || process.argv.includes('-y')) {
    process.stdout.write(question + ' [auto: Y]\n');
    return true;
  }
  if (!_rl) _rl = createRL({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => {
    _rl.question(question, ans => {
      const a = ans.trim().toLowerCase();
      resolve(a === '' || a === 'y' || a === 'yes');
    });
  });
}

function _closeRL() { if (_rl) { _rl.close(); _rl = null; } }

/**
 * Resolve the canonical repo root to use for generated paths (shell alias,
 * service configs, etc.). Prefers ~/.myelin/repo once it actually contains
 * a working checkout — this is where the shell alias will point future
 * `myelin` invocations — falling back to wherever *this* script instance
 * currently lives (e.g. still ~/.tokenstack/repo mid-migration). Always
 * consulting the canonical path first, rather than blindly using
 * import.meta.url, means generated configs stay valid even after a legacy
 * ~/.tokenstack checkout is deleted on a later run.
 */
function resolveRepoRoot(home, os) {
  const sep = os === 'windows' ? '\\' : '/';
  const canonical = join(home, '.myelin', 'repo');
  if (existsSync(join(canonical, 'src', 'cli', 'index.mjs'))) return canonical + sep;
  const currentRoot = fileURLToPath(new URL('..', import.meta.url));
  if (os === 'windows') {
    const normalizedCurrentRoot = normalizeWindowsFilesystemPath(currentRoot);
    if (!/^[a-zA-Z]:\\/u.test(normalizedCurrentRoot) && !normalizedCurrentRoot.startsWith('\\\\')) {
      return canonical + sep;
    }
  }
  return currentRoot;
}

/**
 * Return the path to the Myelin mitmproxy addon script.
 * Resolves relative to the myelin repo root so it works on all platforms.
 */
export function mitmAddonPath(home, os) {
  return join(resolveRepoRoot(home, os), 'src', 'mitm', 'copilot_addon.py');
}

/**
 * Write a serena MCP wrapper script that detects the git root from CWD at spawn time.
 * Solves Copilot launching MCP servers from a generic CWD instead of the project dir.
 */
function writeSerenaWrapper(home, serenaBin) {
  const binDir = join(home, '.myelin', 'bin');
  mkdirSync(binDir, { recursive: true });
  if (process.platform === 'win32') {
    const ps1 = join(binDir, 'serena-mcp.ps1');
    writeFileSync(ps1, `# Detect git root from CWD and pass to serena
$dir = (Get-Location).Path
while ($dir -ne [System.IO.Path]::GetPathRoot($dir)) {
  if (Test-Path (Join-Path $dir '.git')) { break }
  if (Test-Path (Join-Path $dir '.serena\project.yml') -or (Test-Path (Join-Path $dir '.myelin\project.yml'))) { break }
  $dir = Split-Path $dir -Parent
}
& '${serenaBin.replace(/\\/g, '\\\\')}' start-mcp-server --project $dir @args
`, 'utf8');
    const cmd = join(binDir, 'serena-mcp.cmd');
    writeFileSync(cmd, `@echo off\npowershell -ExecutionPolicy Bypass -File "${ps1}" %*\n`, 'utf8');
    return cmd;
  }
  const sh = join(binDir, 'serena-mcp');
  writeFileSync(sh, `#!/bin/sh
dir="$PWD"
while [ "$dir" != "/" ]; do
  [ -d "$dir/.git" ] && break
  [ -f "$dir/.serena/project.yml" ] && break
  [ -f "$dir/.myelin/project.yml" ] && break
  dir="$(dirname "$dir")"
done
exec "${serenaBin}" start-mcp-server --project "$dir" "$@"
`, 'utf8');
  try { execSync(`chmod +x "${sh}"`, { stdio: 'pipe' }); } catch {}
  return sh;
}

/**
 * Write a codegraph MCP wrapper that re-roots the process at the repo before
 * launching `codegraph mcp`, so it finds the repo-local `.codegraph/graph.db`
 * even when the client spawns MCP servers from a generic working directory.
 */
function writeCodegraphWrapper(home, codegraphBin) {
  const binDir = join(home, '.myelin', 'bin');
  mkdirSync(binDir, { recursive: true });
  if (process.platform === 'win32') {
    const ps1 = join(binDir, 'codegraph-mcp.ps1');
    writeFileSync(ps1, `# Detect git/codegraph root from CWD and launch codegraph there
$dir = (Get-Location).Path
while ($dir -ne [System.IO.Path]::GetPathRoot($dir)) {
  if (Test-Path (Join-Path $dir '.git')) { break }
  if (Test-Path (Join-Path $dir '.codegraph\\graph.db')) { break }
  if (Test-Path (Join-Path $dir '.myelin\\project.yml')) { break }
  $dir = Split-Path $dir -Parent
}
Set-Location $dir
& '${codegraphBin.replace(/\\/g, '\\\\')}' mcp @args
`, 'utf8');
    const cmd = join(binDir, 'codegraph-mcp.cmd');
    writeFileSync(cmd, `@echo off\npowershell -ExecutionPolicy Bypass -File "${ps1}" %*\n`, 'utf8');
    return cmd;
  }
  const sh = join(binDir, 'codegraph-mcp');
  writeFileSync(sh, `#!/bin/sh
dir="$PWD"
while [ "$dir" != "/" ]; do
  [ -e "$dir/.git" ] && break
  [ -f "$dir/.codegraph/graph.db" ] && break
  [ -f "$dir/.myelin/project.yml" ] && break
  dir="$(dirname "$dir")"
done
cd "$dir" || exit 1
exec "${codegraphBin}" mcp "$@"
`, 'utf8');
  try { execSync(`chmod +x "${sh}"`, { stdio: 'pipe' }); } catch {}
  return sh;
}

/**
 * Detect the mitmdump binary path (cross-platform).
 * Checks existence for absolute paths, then tries running --version.
 */
export function detectMitmdump(os) {
  const candidates =
    os === 'windows'
      ? [
          join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Python', 'Scripts', 'mitmdump.exe'),
          join(process.env.APPDATA ?? '', 'Python', 'Scripts', 'mitmdump.exe'),
          // pip install --user puts in versioned paths e.g. Python313\Scripts
          ...[...Array(8)].map((_, i) =>
            join(process.env.APPDATA ?? '', 'Python', `Python3${10 + i}`, 'Scripts', 'mitmdump.exe')
          ),
          ...[...Array(8)].map((_, i) =>
            join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Python', `Python3${10 + i}`, 'Scripts', 'mitmdump.exe')
          ),
          join(homedir(), '.local', 'bin', 'mitmdump.exe'),
          'mitmdump',
        ]
      : [
          '/opt/homebrew/bin/mitmdump',
          '/usr/local/bin/mitmdump',
          '/usr/bin/mitmdump',
          join(homedir(), '.local', 'bin', 'mitmdump'),
          join(homedir(), '.local', 'bin', 'mitmdump.exe'),
          'mitmdump',
        ];

  for (const c of candidates) {
    const isAbsolute = c.startsWith('/') || c.includes('\\');
    if (isAbsolute && !existsSync(c)) continue;
    // For absolute paths that exist, skip --version check — just return it
    if (isAbsolute && existsSync(c)) return c;
    try {
      execSync(`"${c}" --version`, { stdio: 'ignore', timeout: 5000 });
      return c;
    } catch { /* not found in PATH */ }
  }
  return null;
}

const LOOPBACK_PROXY_PATTERN = /https?:\/\/(127\.\d+\.\d+\.\d+|localhost):\d+\/?/i;

export function buildMitmServiceInstallOptions({
  cfg = {},
  os,
  home = homedir(),
  mitmdumpBin,
  sslEnv = buildCorporateSslEnv(),
  corpProxy = cfg?.proxy?.headroom?.corporate_proxy ?? '',
  winManager = cfg?.proxy?.windows_service?.manager ?? 'registry',
  headroomPort = selectedEnginePort(cfg),
} = {}) {
  const mitmCfg = cfg?.proxy?.mitm ?? {};
  const { MYELIN_COMPRESS, copilotHeadroomPort } = resolveMitmCompression(cfg);
  const egressPort = copilotHeadroomPort ? (mitmCfg.egress_port ?? 8889) : undefined;
  const normalizedHomeCandidate = os === 'windows' ? normalizeWindowsFilesystemPath(home) : home;
  const effectiveHome = os === 'windows' && !/^(?:[a-z]:\\|\\\\)/i.test(normalizedHomeCandidate)
    ? defaultWindowsHome(home)
    : normalizedHomeCandidate;
  const envVars = {
    MYELIN_HEADROOM_PORT: String(headroomPort),
    MYELIN_COMPRESS,
    ...(copilotHeadroomPort ? { MYELIN_COPILOT_HEADROOM_PORT: String(copilotHeadroomPort) } : {}),
    ...(mitmCfg.block_bypass ? { MYELIN_BLOCK_BYPASS: '1' } : {}),
    ...(mitmCfg.block_marker ? { MYELIN_BLOCK_MARKER: mitmCfg.block_marker } : {}),
    ...(mitmCfg.override_proxy ? { MYELIN_OVERRIDE_PROXY: mitmCfg.override_proxy } : {}),
    ...(mitmCfg.vpn_domains_file ? { MYELIN_VPN_DOMAINS_FILE: mitmCfg.vpn_domains_file } : {}),
    ...(mitmCfg.extra_providers ? { MYELIN_EXTRA_PROVIDERS: mitmCfg.extra_providers } : {}),
    ...sslEnv,
  };
  if (os === 'windows') {
    for (const key of ['SSL_CERT_FILE', 'REQUESTS_CA_BUNDLE', 'NODE_EXTRA_CA_CERTS', 'HEADROOM_CA_BUNDLE', 'MYELIN_VPN_DOMAINS_FILE']) {
      if (envVars[key]) envVars[key] = normalizeWindowsFilesystemPath(envVars[key]);
    }
  }
  return {
    mitmdumpBin: os === 'windows' ? normalizeWindowsFilesystemPath(mitmdumpBin) : mitmdumpBin,
    port: mitmCfg.port ?? 8888,
    addonPath: os === 'windows' ? normalizeWindowsFilesystemPath(mitmAddonPath(effectiveHome, os)) : mitmAddonPath(effectiveHome, os),
    envVars,
    upstreamProxy: String(corpProxy ?? '').replace(LOOPBACK_PROXY_PATTERN, '').trim(),
    logPath: os === 'windows' ? normalizeWindowsFilesystemPath(join(effectiveHome, '.myelin', 'mitmproxy.log')) : join(effectiveHome, '.myelin', 'mitmproxy.log'),
    home: effectiveHome,
    egressPort,
    manager: winManager,
  };
}

/**
 * Install mitmproxy (mitmdump) if not present.
 * Mac: brew. Windows: pip (pipx). Linux: pip via uv.
 * Returns the mitmdump binary path.
 */
async function ensureMitmproxy(os) {
  let bin = detectMitmdump(os);
  if (bin) return bin;

  console.log('  Installing mitmproxy…');
  try {
    if (os === 'darwin') {
      // brew exits non-zero if already installed via different formula; ignore exit code
      try { execSync('brew install mitmproxy', { stdio: 'inherit' }); } catch {}
    } else if (os === 'windows') {
      try { execSync('pip install --user mitmproxy', { stdio: 'inherit' }); } catch {}
    } else {
      try { execSync('pip install --user mitmproxy', { stdio: 'inherit' }); } catch {}
    }
  } catch {}

  bin = detectMitmdump(os);
  if (bin) { ok(`mitmproxy (${bin})`); return bin; }
  const installCmd = os === 'darwin' ? 'brew install mitmproxy'
                   : os === 'windows' ? 'pip install mitmproxy'
                   : 'pip3 install --user mitmproxy';
  warn(`mitmdump not found after install — install manually: ${installCmd}`);
  return null;
}

/**
 * Generate the mitmproxy CA (runs mitmdump briefly if CA does not exist).
 * Returns the CA cert path, or null.
 */
async function ensureMitmCA(home, mitmdumpBin) {
  const caPath = join(home, '.mitmproxy', 'mitmproxy-ca-cert.pem');
  if (existsSync(caPath)) return caPath;
  if (!mitmdumpBin) return null;

  ok('Generating mitmproxy CA (one-time)…');
  try {
    // Run mitmdump briefly in background; poll for CA file (appears in ~0.5-2s)
    const proc = spawn(mitmdumpBin, ['--listen-port', '19876'], {
      detached: true,
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    proc.unref();
    const pid = proc.pid;
    if (!pid) throw new Error('spawn failed — no PID');

    // Poll up to 15s
    for (let i = 0; i < 30; i++) {
      await new Promise(r => setTimeout(r, 500));
      if (existsSync(caPath)) break;
    }
    try { process.kill(pid, 'SIGTERM'); } catch {}
  } catch (e) {
    warn(`CA generation failed: ${e.message}`);
  }

  if (!existsSync(caPath)) {
    skip(`mitmproxy CA not found — run manually: mitmdump --listen-port 19876 &; sleep 3; kill %1`);
    return null;
  }
  return caPath;
}

/**
 * Copilot/Claude wrappers are now defined in ./service/wrappers.mjs so they
 * can be unit-tested for env-var isolation. Never set provider env vars
 * globally (shell profile / Windows registry) — always via these wrappers.
 */
async function main() {
  const { values: flags } = parseArgs({
    options: {
      profile:         { type: 'string',  default: 'proxy' },
      'index-tier':    { type: 'string',  default: 'default' },
      'no-headroom':   { type: 'boolean', default: false },
      'no-rtk':        { type: 'boolean', default: false },
      'copilot-only':  { type: 'boolean', default: false },
      'claude-only':   { type: 'boolean', default: false },
      check:           { type: 'boolean', default: false },
      'dry-run':       { type: 'boolean', default: false },
      yes:             { type: 'boolean', default: false, short: 'y' },
    },
    strict: false,
  });

  const os       = detectOS();
  const shell    = detectShell();
  const home     = homedir();
  const claudeCC = !flags['copilot-only'];
  const copilot  = !flags['claude-only'];

  console.log('\n🧬 Myelin Installer — ' + os + '\n');

  // Migrate ~/.tokenstack → ~/.myelin (one-time)
  const oldDir = join(home, '.tokenstack');
  const newDir = join(home, '.myelin');
  // Also handle the case where Move-Item put .tokenstack *inside* .myelin
  const nestedOld = join(newDir, '.tokenstack');
  const runningFromOld = process.argv[1]?.startsWith(oldDir);
  const runningFromNested = process.argv[1]?.startsWith(nestedOld);
  let didMigrate = false;

  if (existsSync(nestedOld)) {
    // Move non-repo contents of .myelin/.tokenstack up into .myelin
    // Safe to run even when running from inside nestedOld — we skip repo and don't delete if locked
    try {
      const { readdirSync, renameSync } = await import('node:fs');
      for (const entry of readdirSync(nestedOld)) {
        if (entry === 'repo') continue; // repo may be locked if running from it
        const src = join(nestedOld, entry);
        const dst = join(newDir, entry);
        if (!existsSync(dst)) renameSync(src, dst);
      }
      // Move repo to correct location only if not currently running from it
      const nestedRepo = join(nestedOld, 'repo');
      const correctRepo = join(newDir, 'repo');
      if (!runningFromNested && existsSync(nestedRepo) && !existsSync(correctRepo)) {
        const { renameSync } = await import('node:fs');
        renameSync(nestedRepo, correctRepo);
      }
      // Only delete nestedOld if not running from it
      if (!runningFromNested) {
        const { rmSync } = await import('node:fs');
        rmSync(nestedOld, { recursive: true, force: true });
        ok('Cleaned up nested ~/.myelin/.tokenstack → ~/.myelin');
      } else {
        ok('Migrated runtime files from nested .tokenstack (repo stays until next install from correct path)');
      }
      didMigrate = true;
    } catch (e) { warn(`Nested migration failed: ${e.message.split('\n')[0]}`); }
  }

  if (existsSync(oldDir) && !existsSync(newDir) && !runningFromOld) {
    // On Windows, running processes lock the venv dir — stop them first
    if (os === 'windows') {
      try { execSync('powershell -Command "Stop-Process -Name headroom,mitmdump -ErrorAction SilentlyContinue"', { stdio: 'pipe' }); } catch {}
      await new Promise(r => setTimeout(r, 1000));
    }
    try {
      const { renameSync } = await import('node:fs');
      renameSync(oldDir, newDir);
      ok('Migrated ~/.tokenstack → ~/.myelin');
      didMigrate = true;
    } catch {
      // Fallback: copy + delete (handles cross-device or locked files)
      try {
        execSync(os === 'windows'
          ? `robocopy "${oldDir}" "${newDir}" /E /MOVE /NFL /NDL /NJH /NJS`
          : `cp -r "${oldDir}" "${newDir}" && rm -rf "${oldDir}"`,
          { stdio: 'pipe', shell: true });
        ok('Migrated ~/.tokenstack → ~/.myelin (via copy)');
        didMigrate = true;
      } catch (e2) {
        warn(`Could not migrate ~/.tokenstack → ~/.myelin: ${e2.message.split('\n')[0]} — continuing`);
      }
    }
  } else if (existsSync(oldDir) && existsSync(newDir)) {
    const oldRepo = join(oldDir, 'repo');
    const newRepoDir = join(newDir, 'repo');
    if (runningFromOld) {
      // The currently-executing script's own files live under oldDir —
      // deleting it now would pull the source tree out from under this
      // very process (dynamic imports later in this run would then fail
      // with MODULE_NOT_FOUND). Defer cleanup to the next run.
      // Instead, pre-populate the canonical ~/.myelin/repo location with a
      // COPY (not move — oldDir must stay intact for the rest of this run)
      // so resolveRepoRoot() below picks it up immediately: the shell
      // alias/service configs generated later in *this same run* will
      // already point at newRepoDir, and the *next* invocation (now
      // running from newRepoDir) will finish removing oldDir.
      if (existsSync(oldRepo) && !existsSync(newRepoDir)) {
        try {
          execSync(os === 'windows'
            ? `robocopy "${oldRepo}" "${newRepoDir}" /E /NFL /NDL /NJH /NJS`
            : `cp -r "${oldRepo}" "${newRepoDir}"`,
            { stdio: 'pipe', shell: true });
          ok('Copied repo to ~/.myelin/repo (removing ~/.tokenstack next run)');
        } catch (e) {
          warn(`Could not pre-copy repo to ~/.myelin/repo: ${e.message.split('\n')[0]}`);
        }
      } else {
        ok('~/.tokenstack still in use by this run — will remove on next install/update');
      }
    } else {
      try {
        const { rmSync } = await import('node:fs');
        rmSync(oldDir, { recursive: true, force: true });
        ok('Removed legacy ~/.tokenstack');
      } catch {}
    }
  }

  // Migrate old launchd/systemd service names
  if (os === 'darwin') {
    try {
      execSync('launchctl bootout gui/$(id -u)/com.tokenstack.headroom 2>/dev/null || true', { shell: true, stdio: 'pipe' });
      const oldPlist = join(home, 'Library', 'LaunchAgents', 'com.tokenstack.headroom.plist');
      if (existsSync(oldPlist)) { const { unlinkSync } = await import('node:fs'); unlinkSync(oldPlist); ok('Removed legacy com.tokenstack.headroom launchd service'); }
    } catch {}
    // Patch any headroom plist that still references ~/.tokenstack CA paths
    try {
      const { readdirSync, readFileSync } = await import('node:fs');
      const la = join(home, 'Library', 'LaunchAgents');
      const plists = readdirSync(la).filter(f => f.endsWith('.headroom.plist') && !f.includes('.bak'));
      for (const pf of plists) {
        const fp = join(la, pf);
        const raw = readFileSync(fp, 'utf8');
        if (raw.includes('.tokenstack')) {
          writeFileSync(fp, raw.replaceAll('.tokenstack', '.myelin'), 'utf8');
          ok(`Patched ${pf}: .tokenstack → .myelin CA paths`);
        }
      }
    } catch {}
  } else if (os === 'linux') {
    try {
      execSync('systemctl --user disable --now tokenstack-headroom.service 2>/dev/null || true', { stdio: 'pipe' });
      const oldUnit = join(home, '.config', 'systemd', 'user', 'tokenstack-headroom.service');
      if (existsSync(oldUnit)) { const { unlinkSync } = await import('node:fs'); unlinkSync(oldUnit); ok('Removed legacy tokenstack-headroom systemd service'); }
    } catch {}
  }

  // Clear stale SSL env vars pointing to old ~/.tokenstack path
  for (const v of ['SSL_CERT_FILE', 'REQUESTS_CA_BUNDLE', 'NODE_EXTRA_CA_CERTS', 'HEADROOM_CA_BUNDLE', 'CURL_CA_BUNDLE', 'GIT_SSL_CAINFO']) {
    if (process.env[v]?.includes('.tokenstack')) delete process.env[v];
  }

  console.log('Detecting existing installations...');

  const tools     = await detectAll();
  const { proxy: corpProxy } = detectCorporateProxy();
  const caBundles = detectCaBundles();
  const sslEnv    = buildCorporateSslEnv(caBundles[0]?.path ?? null);

  if (flags.check) { printStateTable(tools, caBundles, corpProxy); process.exit(0); }

  mkdirSync(join(home, '.myelin'), { recursive: true });
  const existingCfg = await loadConfig(DEFAULT_CONFIG_PATH);
  const copilotHudEnabled = Boolean(existingCfg.copilot_hud?.enabled);
  const tokenOptimizerEnabled = existingCfg.observability?.token_optimizer === true;
  const codegraphEnabled = existingCfg.code_discovery?.codegraph === true;
  const venv = join(home, '.myelin', 'venv');
  // Gated on BOTH the config flag AND actual presence — a leftover global
  // install from a prior "enabled: true" run (or an unrelated `npm install -g
  // @optave/codegraph` on the machine) must never cause MCP registration
  // while the flag is false. See claudeMcpServers/copilotMcpServers below for
  // the matching cleanup: an explicit `codegraph: undefined` actively strips
  // any stale entry mergeJsonFile previously wrote (mergeDeepPlain otherwise
  // never deletes keys — only overlays what's present in the update object).
  let codegraphReady = codegraphEnabled && tools.codegraph.installed;
  let port = existingCfg.proxy.headroom.port;
  let persistHeadroomFallback = false;
  let selectedProxyPort = existingCfg.proxy?.engine === 'headroom_lite'
    ? (existingCfg.proxy?.headroom_lite?.port ?? 8790)
    : port;
  if (!(await isPortFree(port))) {
    const alreadyOurs = await import('./tools/headroom.mjs').then(m => m.waitForHeadroom(port, 1500)).catch(() => false);
    if (alreadyOurs) {
      ok(`Headroom already running on port ${port} — keeping`);
    } else {
      warn(`Port ${port} in use. Finding a free port...`);
      port = await findFreePort(port + 1, port + 20);
      ok(`Using port ${port}`);
    }
  }
  if (existingCfg.proxy?.engine !== 'headroom_lite') selectedProxyPort = port;

  if (flags['dry-run']) {
    console.log('\n[dry-run] Would install / configure:');
    const dryRunTools = ['uv', 'serena', 'semble', 'ast-grep', ...(existingCfg.budget_routing?.litellm ? ['litellm'] : []), ...(codegraphEnabled ? ['codegraph'] : []), 'rtk', 'mitmproxy'];
    console.log(`  ${dryRunTools.join(', ')}`);
    if (copilotHudEnabled && copilot) console.log('  copilot-hud plugin');
    if (!flags['no-headroom']) console.log('  headroom-ai[all] from PyPI');
    if (flags.profile === 'proxy') console.log(`  headroom service on port ${port}, mitmproxy service on port 8888`);
    if (claudeCC) console.log('  ~/.claude/settings.json, CLAUDE.md, hooks');
    if (copilot)  console.log('  ~/.copilot/mcp-config.json');
    console.log('  shell profile HEADROOM_PORT + _copilot/_claude wrappers (per-invocation env, no global pollution)');
    console.log('\n[dry-run] No changes made.\n');
    return;
  }


  step('[1/7] Package manager...');
  await ensureUv();
  ok('uv ready');

  // 2. Code discovery tools
  step('[2/7] Code discovery tools...');
  if (!tools.serena.installed) {
    console.log('  Installing Serena (oraios/serena)...');
    if (os === 'windows') {
      try { execSync('powershell -Command "Get-Process -Name \'serena-agent\' -ErrorAction SilentlyContinue | Stop-Process -Force"', { stdio: 'pipe' }); } catch {}
      await new Promise(r => setTimeout(r, 500));
    }
    try {
      execSync('uv tool install --python 3.12 "serena-agent @ git+https://github.com/oraios/serena.git"', { stdio: 'pipe' });
      ok('serena installed');
    } catch (e) {
      const output = `${e?.message ?? ''}\n${e?.stderr?.toString?.() ?? ''}\n${e?.stdout?.toString?.() ?? ''}`.toLowerCase();
      if (os === 'windows' && (output.includes('access is denied') || output.includes('os error 5') || output.includes('cannot access the file'))) {
        warn('serena install failed: MCP server process still locked. Stop Claude Code / Copilot CLI and re-run: myelin install --yes');
      } else {
        if (e?.stdout) process.stdout.write(e.stdout);
        if (e?.stderr) process.stderr.write(e.stderr);
        throw e;
      }
    }
  } else { skip(`serena (${tools.serena.version})`); }
  // Always ensure bottle<0.13 in serena env — 0.13+ is pyzapp (no .py), breaks webview
  try {
    const serenaEnv = execSync('uv tool dir', { stdio: 'pipe' }).toString().trim();
    const bottlePath = join(serenaEnv, 'serena-agent');
    execSync(`uv pip install --python "${bottlePath}" "bottle<0.13"`, { stdio: 'pipe' });
  } catch {}
  // Serena opens a browser tab/window every time its MCP server starts by
  // default (web_dashboard_open_on_launch: true) - quality-of-life fix,
  // never worth failing the install over if it doesn't apply yet (config
  // file may not exist until Serena's first run, e.g. via `myelin init`).
  try {
    if (applyDisableSerenaDashboardAutoOpen(home)) ok('serena dashboard auto-open disabled');
  } catch {}

  if (!tools.semble.installed) {
    console.log('  Installing Semble...');
    if (os === 'windows') {
      try { execSync('powershell -Command "Get-Process -Name \'semble\' -ErrorAction SilentlyContinue | Stop-Process -Force"', { stdio: 'pipe' }); } catch {}
      await new Promise(r => setTimeout(r, 500));
    }
    let sembleInstalled = false;
    try {
      execSync('uv tool install "semble[mcp]"', { stdio: 'pipe' });
      sembleInstalled = true;
    } catch (e) {
      const output = `${e?.message ?? ''}\n${e?.stderr?.toString?.() ?? ''}\n${e?.stdout?.toString?.() ?? ''}`.toLowerCase();
      if (os === 'windows' && (output.includes('access is denied') || output.includes('os error 5') || output.includes('cannot access the file'))) {
        warn('semble install failed: MCP server process still locked. Stop Claude Code / Copilot CLI and re-run: myelin install --yes');
      } else {
        if (e?.stdout) process.stdout.write(e.stdout);
        if (e?.stderr) process.stderr.write(e.stderr);
        throw e;
      }
    }
    if (sembleInstalled) {
      try {
        execSync(`semble install ${claudeCC ? '--agent claude --type mcp subagent' : ''} --yes`, { stdio: 'pipe' });
      } catch {}
      ok('semble installed');
    }
  } else { skip('semble (installed)'); }

  // agentcairn — best-in-class local memory MCP (Obsidian vault + DuckDB, LongMemEval top score)
  {
    const cairnInstalled = (() => { try { execSync('uv tool run --from agentcairn cairn --version', { stdio: 'pipe', timeout: 5000 }); return true; } catch { return false; } })();
    if (!cairnInstalled) {
      console.log('  Installing agentcairn...');
      try {
        execSync('uv tool install --python 3.12 agentcairn', { stdio: 'inherit' });
        ok('agentcairn installed');
      } catch { warn('agentcairn install failed — will use uvx fallback'); }
    } else { skip('agentcairn (installed)'); }
    // Claude Code plugin gives richer auto-recall hooks — install if claude CLI is available
    if (claudeCC) {
      try {
        execSync('claude plugin list 2>/dev/null | grep -q agentcairn || (claude plugin marketplace add ccf/agentcairn 2>/dev/null && claude plugin install agentcairn@agentcairn --yes 2>/dev/null)', { shell: true, stdio: 'pipe', timeout: 30000 });
      } catch {}
    }
  }

  if (!tools.astgrep.installed) {
    console.log('  Installing ast-grep...');
    if (os === 'darwin') {
      try { execSync('brew install ast-grep', { stdio: 'inherit' }); ok('ast-grep (brew)'); }
      catch { execSync('cargo install ast-grep --locked', { stdio: 'inherit' }); ok('ast-grep (cargo)'); }
    } else if (os === 'linux') {
      // Try npm package (cross-platform, no cargo needed), then GitHub release, then cargo
      try {
        execSync('npm install -g @ast-grep/cli', { stdio: 'inherit' });
        ok('ast-grep (npm)');
      } catch {
        try { execSync('cargo install ast-grep --locked', { stdio: 'inherit' }); ok('ast-grep (cargo)'); }
        catch { warn('ast-grep install failed — install manually: npm install -g @ast-grep/cli'); }
      }
    } else {
      // Windows: no cargo by default — use npm
      try { execSync('npm install -g @ast-grep/cli', { stdio: 'inherit' }); ok('ast-grep (npm)'); }
      catch { warn('ast-grep install failed — install manually: npm install -g @ast-grep/cli'); }
    }
  } else { skip(`ast-grep (${tools.astgrep.version})`); }

  if (copilotHudEnabled && copilot) {
    // jq is only needed by copilot-hud's POSIX shell hooks — not on Windows.
    // On Windows, skip the check entirely. On Mac/Linux, try to auto-install.
    let jqOk = os === 'windows';
    if (!jqOk) {
      jqOk = Boolean(await which('jq'));
      if (!jqOk) {
        if (os === 'darwin') {
          console.log('  Installing jq (required by copilot-hud)...');
          try { execSync('brew install jq', { stdio: 'inherit' }); jqOk = true; ok('jq'); }
          catch { warn('jq install failed — install manually: brew install jq'); }
        } else {
          warn('copilot-hud requires jq — install it (e.g. sudo apt-get install jq) then re-run');
        }
      }
    }
    if (jqOk) {
      const copilotPath = await which('copilot');
      if (!copilotPath) {
        warn('copilot-hud requested but Copilot CLI not found — skipping');
      } else {
        const copilotHud = await detectCopilotHud();
        if (copilotHud.installed) {
          skip(`copilot-hud (${copilotHud.version ?? 'installed'})`);
        } else {
          console.log('  Installing copilot-hud...');
          try {
            execSync('copilot plugin marketplace add griches/copilot-hud', { stdio: 'inherit' });
          } catch {
            warn('copilot-hud marketplace add failed — attempting install anyway');
          }
          try {
            execSync('copilot plugin install copilot-hud@copilot-hud', { stdio: 'inherit' });
            ok('copilot-hud installed');
            console.log('  Next: run `copilot --experimental`, then `/copilot-hud:setup` once inside the session.');
          } catch {
            warn('copilot-hud install failed — install manually: copilot plugin marketplace add griches/copilot-hud && copilot plugin install copilot-hud@copilot-hud');
          }
        }
      }
    }
  } else if (copilotHudEnabled && !copilot) {
    skip('copilot-hud skipped (--claude-only)');
  }

  if (tokenOptimizerEnabled && copilot) {
    installTokenOptimizerForCopilot({
      os,
      exec: (command, options = {}) => execSync(command, { stdio: 'inherit', ...options }),
      log: (message = '') => console.log(`  ${message}`),
      warn,
    });
    // The external installer writes an unguarded python-bridge preToolUse hook;
    // make it fail-open so a bridge/python failure can't fail-CLOSE bash tool
    // calls. See src/tools/hook-safety.mjs.
    try {
      if (hardenCopilotTokenOptimizerHook({ home }).action === 'hardened') {
        ok('~/.copilot/hooks/token-optimizer.json (fail-open guard)');
      }
    } catch { /* never fail install over defensive hardening */ }
  } else if (tokenOptimizerEnabled && !copilot) {
    skip('token-optimizer Copilot install skipped (--claude-only)');
  }

  if (tokenOptimizerEnabled && claudeCC) {
    warn(tokenOptimizerLicenseNotice());
    console.log(`  ${tokenOptimizerClaudeCodeInstructions().replace(/\n/g, '\n  ')}`);
  } else if (tokenOptimizerEnabled && !claudeCC) {
    skip('token-optimizer Claude Code instructions skipped (--copilot-only)');
  }

  // LiteLLM budget routing (opt-in)
  if (existingCfg.budget_routing?.litellm) {
    step('LiteLLM budget router...');
    try {
      if (!existsSync(join(venv, 'pyvenv.cfg'))) {
        execSync(`uv venv "${venv}"`, { stdio: 'pipe' });
      }
      execSync(`uv pip install --python "${venv}" "litellm[proxy]>=1.92"`, { stdio: 'inherit' });
      const { generateLiteLLMConfig, liteLLMConfigPath } = await import('./service/litellm-service.mjs');
      const cfgPath = liteLLMConfigPath(home);
      const litellmPort = existingCfg.budget_routing?.litellm_port ?? 4000;
      // LiteLLM talks to an upstream provider directly, so it needs its own
      // explicit API base. Copilot-Headroom does not expose provider URL config:
      // it loops back through mitmproxy and restores the original destination.
      const apiBase = existingCfg.budget_routing?.api_base?.trim() || '';
      if (!apiBase) {
        warn(
          'litellm enabled but budget_routing.api_base is empty. ' +
          'Set it via `myelin config set budget_routing.api_base https://api.githubcopilot.com` ' +
          '(or https://api.business.githubcopilot.com for Business/Enterprise) and re-run — writing config anyway; litellm will fail to start until this is set.'
        );
      }
      const content = generateLiteLLMConfig({
        headroomPort: existingCfg.proxy?.headroom?.port ?? 8787,
        litellmPort,
        cheapModel: existingCfg.budget_routing?.cheap_model ?? 'claude-haiku-4-5',
        complexModel: existingCfg.budget_routing?.complex_model ?? 'claude-sonnet-4-6',
        apiBase,
      });
      writeFileSync(cfgPath, content, 'utf8');
      ok(`litellm config written → ${cfgPath}`);
      ok(`LiteLLM will listen on :${litellmPort}. To route Claude Code through it, use the _claude wrapper with headroom_port set to ${litellmPort} (never set ANTHROPIC_BASE_URL globally — see _claude wrapper in src/service/wrappers.mjs).`);
    } catch (e) {
      warn(`litellm install failed: ${e.message.split('\n')[0]}`);
    }
  }

  if (codegraphEnabled) {
    if (codegraphReady) {
      skip(`codegraph (${tools.codegraph.version})`);
    } else if (!isVersionAtLeast(tools.node.version ?? '', '22.12.0')) {
      warn('codegraph skipped — @optave/codegraph currently requires Node >=22.12.0 upstream (Myelin itself requires only >=20)');
    } else {
      console.log('  Installing codegraph...');
      try {
        execSync('npm install -g @optave/codegraph', { stdio: 'inherit' });
        ok('codegraph installed');
        codegraphReady = true;
      } catch {
        warn('codegraph install failed — install manually: npm install -g @optave/codegraph');
      }
    }
  }

  // 3. Proxy backbone
  step('[3/7] Proxy backbone...');
  if (!flags['no-headroom']) {
    if (!tools.headroom.installed) {
      console.log('  Installing headroom...');
      if (!existsSync(join(venv, 'pyvenv.cfg'))) {
        execSync(`uv venv "${venv}"`, { stdio: 'pipe' });
      }
      // Single quotes break on Windows cmd — use double quotes or no quotes
      const headroomPkg = os === 'windows' ? '"headroom-ai[all]"' : "'headroom-ai[all]'";
      execSync(`uv pip install --python "${venv}" ${headroomPkg}`, { stdio: 'inherit' });
      ok('headroom installed (headroom-ai from PyPI)');
    } else { skip(`headroom (${tools.headroom.version})`); }
  }

  // Build combined CA bundle: root CA + intermediate CA extracted from live TLS chain
  // This is required when a corporate SSL interceptor (e.g. NetFree/Hot) uses an intermediate
  // CA that isn't in the system trust store. We extract it from the live connection.
  const combinedCert = await buildCombinedCaCert(caBundles[0]?.path ?? null, home, { force: didMigrate });
  if (combinedCert && combinedCert !== caBundles[0]?.path) {
    // Update sslEnv to point to the combined cert
    Object.keys(sslEnv).forEach(k => { sslEnv[k] = combinedCert; });
    ok(`Combined CA cert built → ${combinedCert}`);
  }

  if (!flags['no-rtk']) {
    if (!tools.rtk.installed) {
      console.log('  Installing RTK...');
      await installRtk(os);
      tools.rtk = await detectRtk();
    } else {
      skip(`rtk (${tools.rtk.version})`);
    }
    const rtkVersionWarning = getRtkVersionWarning(tools.rtk);
    if (rtkVersionWarning) warn(rtkVersionWarning);
  }

  // mitmproxy — install binary + generate CA + append CA to PEM bundles
  const mitmdumpBin = await ensureMitmproxy(os);
  if (mitmdumpBin) {
    await ensureMitmCA(home, mitmdumpBin);
    // non-interactive when --yes: auto-append CA to bundle without prompting
    await installMitmproxyCA(home, !flags['yes']);
    ok('mitmproxy ready');
  } else {
    warn('mitmproxy not available — Copilot compression disabled');
  }

  // 4. Service
  if (!flags['no-headroom'] && flags.profile === 'proxy') {
    step('[4/7] Background service...');
    const binPath = headroomBinPath();
    const cfg = await loadConfig(DEFAULT_CONFIG_PATH);
    const enginePlan = buildServiceEnginePlan(cfg);
    if (enginePlan.selectedEngine === 'headroom') {
      enginePlan.headroomPort = port;
      enginePlan.selectedPort = port;
    }
    const envVars = { HEADROOM_PORT: String(port), ...sslEnv };
    const mitmCfg = cfg.proxy?.mitm ?? {};
    const copilotHeadroomCfg = cfg.proxy?.copilot_headroom ?? {};
    const windowsServiceCfg = cfg.proxy?.windows_service ?? {};
    const winManager = windowsServiceCfg.manager ?? 'registry';
    if (corpProxy) envVars.HTTPS_PROXY = corpProxy;
    envVars.OPENAI_TARGET_API_URL = cfg.proxy.headroom.openai_target_url ?? 'https://api.githubcopilot.com';
    envVars.HEADROOM_MODE = cfg.proxy.headroom.mode ?? 'cache';
    const installPlan = await applyServiceEngineInstallPlan({
      enginePlan,
      os,
      cfg,
      winManager,
      home,
      headroomBin: binPath,
      port,
      envVars,
      interceptToolResults: cfg.proxy.headroom.intercept_tool_results ?? true,
      warnFn: warn,
      logFn: console.log,
      okFn: ok,
    });
    persistHeadroomFallback = persistHeadroomFallback || installPlan.persistHeadroomFallback;
    selectedInstallEngine = installPlan.selectedInstallEngine;
    selectedProxyPort = installPlan.selectedProxyPort;

    // mitmproxy service on port 8888 — intercepts Copilot TLS for compression
    if (mitmdumpBin) {
      const { copilotHeadroomPort } = resolveMitmCompression(cfg);
      const mitmOpts = buildMitmServiceInstallOptions({
        cfg,
        os,
        home,
        mitmdumpBin,
        sslEnv,
        corpProxy,
        winManager,
        headroomPort: enginePlan.selectedPort,
      });
      const egressPort = mitmOpts.egressPort;
      try {
        await installMitmService(mitmOpts);
        ok(`mitmproxy service registered (port ${mitmOpts.port}${mitmOpts.egressPort ? ` + egress ${mitmOpts.egressPort}` : ''})`);

        // Copilot-Headroom: a SEPARATE, dedicated instance that gives Copilot
        // CLI traffic the same full pipeline treatment Claude Code already
        // gets. Its upstream target is the local mitmproxy egress listener,
        // not a Copilot provider URL; mitmproxy restores the original
        // destination from private loopback headers.
        if (copilotHeadroomPort) {
          const loopbackTarget = `http://127.0.0.1:${egressPort}`;
          try {
            await installCopilotHeadroomService({
              headroomBin: binPath,
              port: copilotHeadroomPort,
              envVars: {
                ANTHROPIC_TARGET_API_URL: loopbackTarget,
                OPENAI_TARGET_API_URL: loopbackTarget,
                HEADROOM_MODE: copilotHeadroomCfg.mode ?? 'cache',
                NO_PROXY: '127.0.0.1,localhost,::1',
                ...sslEnv,
              },
              home,
              manager: winManager,
            });
            ok(`copilot-headroom service registered (port ${copilotHeadroomPort}, egress ${egressPort})`);
          } catch (e) {
            warn(`copilot-headroom service registration failed: ${e.message}`);
          }
        }
      } catch (e) {
        warn(`mitmproxy service registration failed: ${e.message}`);
      }
    }

    // Watchdog: macOS uses a launchd poller; Windows can opt into a
    // Scheduled Task health checker for the same second-layer recovery role
    // — only meaningful once windows_service.manager is 'winsw' (there's no
    // WinSW service for a registry-based install's watchdog to restart).
    try {
      const { installWatchdog } = await import('./service/index.mjs');
      const watchdogInterval = Number(windowsServiceCfg.watchdog_interval_minutes ?? 2) || 2;
      const installed = await installWatchdog({
        home,
        enabled: winManager === 'winsw' && (windowsServiceCfg.watchdog_enabled ?? false),
        intervalMinutes: watchdogInterval,
        headroomPort: enginePlan.shouldRunManagedHeadroom ? enginePlan.selectedPort : undefined,
        mitmPort: mitmCfg.port ?? 8888,
        ...(copilotHeadroomCfg.enabled && mitmdumpBin ? {
          copilotHeadroomPort: copilotHeadroomCfg.port ?? 8788,
          egressPort: mitmCfg.egress_port ?? 8889,
        } : {}),
      });
      if (installed) {
        const cadence = os === 'windows'
          ? `every ${watchdogInterval} minute${watchdogInterval === 1 ? '' : 's'}`
          : 'every 90s';
        ok(`watchdog installed — auto-revives dropped services ${cadence}`);
      }
    } catch (e) {
      warn(`watchdog install failed: ${e.message}`);
    }
  } else {
    step('[4/7] Service: skipped');
  }

  // 5. Config files
  step('[5/7] Configuration files...');

  // ~/.myelin/config.yaml
  if (!existsSync(DEFAULT_CONFIG_PATH)) {
    await writeConfig(mergeDeep(DEFAULT_CONFIG, {
      proxy: { headroom: { port, corporate_proxy: corpProxy } },
      index_tier: flags['index-tier'],
    }), DEFAULT_CONFIG_PATH);
    ok(`config.yaml created`);
  } else if (persistHeadroomFallback) {
    await writeConfig(mergeDeep(await loadConfig(DEFAULT_CONFIG_PATH), {
      proxy: {
        engine: 'headroom',
        headroom: { enabled: true, port },
        headroom_lite: { enabled: false },
      },
    }), DEFAULT_CONFIG_PATH);
    ok('config.yaml updated to headroom fallback');
  } else { skip('config.yaml already exists'); }

  // Claude Code settings.json
  // Resolve tool binary paths at install time — needed for Windows where PATH isn't set when Copilot spawns MCPs
  const toolPaths = {};
  for (const t of ['serena', 'semble', 'uvx', ...(codegraphReady ? ['codegraph'] : [])]) {
    try {
      const p = execSync(os === 'windows' ? `where.exe ${t}` : `which ${t}`, { stdio: 'pipe' })
        .toString().trim().split('\n')[0].trim();
      toolPaths[t] = p || t;
    } catch { toolPaths[t] = t; }
  }

  // Write serena wrapper that detects git root from CWD at spawn time
  const serenaWrapper = writeSerenaWrapper(home, toolPaths.serena);
  toolPaths.serenaWrapper = serenaWrapper;
  if (codegraphReady) {
    toolPaths.codegraphWrapper = writeCodegraphWrapper(home, toolPaths.codegraph);
  }

  const memoryFile = os === 'windows'
    ? join(home, '.myelin', 'memory.jsonl').replace(/\//g, '\\')
    : join(home, '.myelin', 'memory.jsonl');
  const repoRoot = resolveRepoRoot(home, os);
  const gitExtraEnabled = existingCfg.code_discovery?.mcp_git_extra !== false;
  const gitExtraServer = gitExtraEnabled
    ? {
        command: os === 'windows' ? 'python' : 'python3',
        args: [join(repoRoot, 'src', 'mcp', 'git-extra.py')],
      }
    : undefined;

  const claudeMcpServers = {
    serena: { command: serenaWrapper, args: [] },
    semble: { command: toolPaths.semble, args: [] },
    // Explicit `undefined` (not a conditional spread) so a previously-written
    // entry gets actively removed by mergeJsonFile once codegraph is
    // disabled again — see codegraphReady comment above.
    codegraph: toolPaths.codegraphWrapper ? { command: toolPaths.codegraphWrapper, args: [] } : undefined,
    'mcp-git': { command: toolPaths.uvx, args: ['mcp-server-git'] },
    'git-extra': gitExtraServer,
    memory: { command: 'npx', args: ['-y', '--registry', 'https://registry.npmjs.org', '@modelcontextprotocol/server-memory'], env: { MEMORY_FILE_PATH: memoryFile } },
    cairn: { command: toolPaths.uvx, args: ['--python', '3.12', 'agentcairn'] },
  };

  const copilotMcpServers = {
    serena: { type: 'local', command: serenaWrapper, args: [], env: {}, tools: ['*'] },
    semble: { type: 'local', command: toolPaths.semble, args: [], env: {}, tools: ['*'] },
    codegraph: toolPaths.codegraphWrapper ? { type: 'local', command: toolPaths.codegraphWrapper, args: [], env: {}, tools: ['*'] } : undefined,
    'mcp-git': { type: 'local', command: toolPaths.uvx, args: ['mcp-server-git'], env: {}, tools: ['*'] },
    'git-extra': gitExtraServer ? { type: 'local', ...gitExtraServer, env: {}, tools: ['*'] } : undefined,
    memory: { type: 'local', command: 'npx', args: ['-y', '--registry', 'https://registry.npmjs.org', '@modelcontextprotocol/server-memory'], env: { MEMORY_FILE_PATH: memoryFile }, tools: ['*'] },
    cairn: { type: 'local', command: toolPaths.uvx, args: ['--python', '3.12', 'agentcairn'], env: {}, tools: ['*'] },
  };

  if (claudeCC) {
    mergeJsonFile(join(home, '.claude', 'settings.json'), {
      env: {
        ANTHROPIC_BASE_URL: `http://127.0.0.1:${selectedProxyPort}`,
        ENABLE_PROMPT_CACHING_1H: '1',
        CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: '50',
        CLAUDE_CODE_SUBAGENT_MODEL: 'claude-sonnet-4-6',
        HEADROOM_PORT: String(selectedProxyPort),
        ...sslEnv,
      },
      mcpServers: claudeMcpServers,
    }, {});
    ok('~/.claude/settings.json (MCPs + proxy env)');
  }

  // Copilot CLI mcp-config.json
  if (copilot) {
    const mcp = join(home, '.copilot', 'mcp-config.json');
    if (existsSync(mcp)) {
      mergeJsonFile(mcp, { mcpServers: copilotMcpServers });
      ok('~/.copilot/mcp-config.json (MCPs)');
    } else { skip('~/.copilot/mcp-config.json not found'); }
  }

  // CLAUDE.md managed section
  let installCfg = await loadConfig(DEFAULT_CONFIG_PATH);

  if (claudeCC) {
    const claudeBlock = renderManagedBlock({
      target: 'global',
      provider: 'claude',
      model: installCfg.copilot?.model,
      cfg: installCfg,
      extraSections: [`## Session\n- /compact when context > 50%. Headroom proxy on port ${selectedProxyPort}.`],
    });
    writeManagedSection(join(home, '.claude', 'CLAUDE.md'), `\n${claudeBlock}`);
    ok('~/.claude/CLAUDE.md managed section');
  }

  const rtkEnabledInConfig = installCfg.shell_compression?.rtk !== false;
  if (!flags['no-rtk'] && rtkEnabledInConfig && tools.rtk.installed) {
    const rtkInitPlans = [];
    const copilotMcpPath = join(home, '.copilot', 'mcp-config.json');
    if (copilot && existsSync(copilotMcpPath)) {
      rtkInitPlans.push({
        label: 'Copilot',
        args: ['init', '--global', '--copilot', '--auto-patch'],
      });
    }
    if (claudeCC) {
      // Plain `rtk init -g` defaults to "N" for settings.json patching in
      // non-interactive installs, so use --auto-patch to ensure hook wiring.
      rtkInitPlans.push({
        label: 'Claude Code',
        args: ['init', '--global', '--auto-patch'],
      });
    }
    // RTK 0.43.0 exposes no subcommand-level rewrite exclusions via `init`,
    // `hook`, `rewrite`, or the generated filters template, so we keep broad
    // shell rewrites even when Headroom intercept_tool_results is enabled.
    for (const plan of rtkInitPlans) {
      const result = runRtkInit(plan.args);
      if (result.ok) {
        ok(`rtk ${plan.args.slice(1).join(' ')} (${plan.label})`);
      } else {
        const summary = result.error || result.output.split('\n').filter(Boolean).at(-1) || `exit ${result.status}`;
        warn(`rtk ${plan.args.slice(1).join(' ')} (${plan.label}) failed: ${summary}`);
      }
    }
    // Intentionally do not auto-run `rtk trust`: project-local .rtk/filters.toml
    // must remain explicit opt-in.
  } else if (!flags['no-rtk'] && !rtkEnabledInConfig) {
    skip('rtk hook wiring disabled by shell_compression.rtk=false');
  }

  // The global RTK Copilot hook MUST be fail-open. `rtk init --copilot` writes a
  // raw `rtk hook copilot` preToolUse hook, which fail-CLOSES every tool call in
  // every session when rtk isn't on Copilot's hook PATH (the Windows brick).
  // Replace it with a guarded, always-exit-0 wrapper (or remove it if RTK is
  // off) — this also heals machines a previous install already bricked. See
  // src/cli/rtk-guard.mjs.
  if (copilot) {
    try {
      const rtkActive = !flags['no-rtk'] && rtkEnabledInConfig && tools.rtk.installed;
      const res = ensureSafeRtkCopilotHook({
        home,
        nodePath: process.execPath,
        repoRoot: resolveRepoRoot(home, os),
        mode: rtkActive ? 'active' : 'inactive',
      });
      if (res.action === 'wrote-guarded') ok('~/.copilot/hooks/rtk-rewrite.json (fail-open guard)');
      else if (res.action === 'removed-unsafe') ok('removed unsafe RTK Copilot hook (RTK disabled)');
    } catch (e) {
      warn(`could not secure RTK Copilot hook: ${e.message.split('\n')[0]}`);
    }
  }

  // Slash commands — lets `myelin init` be re-run from inside a live agent
  // chat session (e.g. after pulling repo updates) without dropping to a
  // shell. Copilot CLI: global skill folder (~/.copilot/skills/<name>/SKILL.md,
  // invoked as /myelin-init — skill names are flat, no ':' namespacing).
  // Claude Code: global command file under a `myelin/` subdirectory, which
  // Claude Code treats as a namespace (invoked as /myelin:init).
  {
    const initSkillBody = `# Myelin Init

Run the Myelin installer's init command to (re)configure the token-efficiency
stack (Serena + Semble registration/indexing for the current git repo).

## Instructions

1. Run \`myelin init $ARGUMENTS\` via the terminal/Bash tool. If the \`myelin\`
   alias isn't on PATH yet in this session, fall back to
   \`node "${resolveRepoRoot(home, os)}src/cli/index.mjs" init $ARGUMENTS\`.
2. Stream the command's output back to the user.
3. If it reports warnings or failures, summarize them clearly and suggest
   \`myelin verify\` as a follow-up health check.
4. Do not pass \`--yes\`/\`--recursive\` unless the user explicitly asked for
   auto-accept or a recursive multi-repo init.
`;
    if (copilot) {
      const skillDir = join(home, '.copilot', 'skills', 'myelin-init');
      mkdirSync(skillDir, { recursive: true });
      writeFileSync(join(skillDir, 'SKILL.md'), `---
name: myelin-init
description: Runs \`myelin init\` to initialize or refresh the Myelin token-efficiency stack (Serena + Semble) for the current repo.
argument-hint: "[--yes] [--recursive] [--depth <n>]"
---

${initSkillBody}`);
      ok('~/.copilot/skills/myelin-init (invoke: /myelin-init)');
    }
    if (claudeCC) {
      const cmdDir = join(home, '.claude', 'commands', 'myelin');
      mkdirSync(cmdDir, { recursive: true });
      writeFileSync(join(cmdDir, 'init.md'), `---
description: Runs \`myelin init\` to initialize or refresh the Myelin token-efficiency stack (Serena + Semble) for the current repo.
argument-hint: [--yes] [--recursive] [--depth <n>]
allowed-tools: [Bash]
---

${initSkillBody}`);
      ok('~/.claude/commands/myelin/init.md (invoke: /myelin:init)');
    }
  }

  // Shell profile
  const profilePath = shellProfilePath(os, shell);
  if (profilePath) {
    if (os === 'windows') mkdirSync(join(profilePath, '..'), { recursive: true });
    const existing = existsSync(profilePath) ? readFileSync(profilePath, 'utf8') : '';
    const certLines = Object.entries(sslEnv)
      .map(([k, v]) => `export ${k}=${v}`)
      .join('\n');
    const certBlock = certLines ? `\n${certLines}` : '';
    const copilotAlias = buildCopilotWrapper({ os });
    const claudeAlias = buildClaudeWrapper({ os, headroomPort: selectedProxyPort });
    const repoRoot = resolveRepoRoot(home, os);
    const myelinCmd = os === 'windows'
      ? `function global:myelin { node "${repoRoot}src/cli/index.mjs" @args }`
      : `alias myelin="node ${repoRoot}src/cli/index.mjs"`;
    const extraPath = os === 'windows' ? '' : '\nexport PATH="$HOME/.local/bin:$HOME/.myelin/bin:$PATH"';

    // On Windows, add key bin dirs to process.env.PATH now so tool invocations work
    if (os === 'windows') {
      const winPaths = [
        join(home, '.local', 'bin'),
        join(home, '.myelin', 'bin'),
        join(home, 'AppData', 'Roaming', 'uv', 'bin'),
        join(home, 'AppData', 'Local', 'uv', 'bin'),
        join(home, 'AppData', 'Roaming', 'npm'),
        join(home, 'AppData', 'Roaming', 'Python', 'Scripts'),
        ...[...Array(8)].map((_, i) => join(home, 'AppData', 'Roaming', 'Python', `Python3${10+i}`, 'Scripts')),
        ...[...Array(8)].map((_, i) => join(home, 'AppData', 'Local', 'Programs', 'Python', `Python3${10+i}`, 'Scripts')),
      ];
      for (const p of winPaths) {
        if (!process.env.PATH?.includes(p)) process.env.PATH = p + ';' + process.env.PATH;
      }
      // Also add node.exe's own directory (covers nvm4w, portable node)
      const nodeDir = join(process.execPath, '..');
      if (!process.env.PATH?.includes(nodeDir)) process.env.PATH = nodeDir + ';' + process.env.PATH;
    }
    let block;
    if (os === 'windows') {
      // NOTE: provider-specific env vars (ANTHROPIC_BASE_URL, HTTPS_PROXY) are
      // deliberately NOT set in $PROFILE — they live only inside the _copilot
      // and _claude wrappers so they can't cross-contaminate each other.
      const psEnv = `$env:HEADROOM_PORT = "${selectedProxyPort}"`;
      const psCert = Object.entries(sslEnv).map(([k, v]) => `$env:${k} = "${v}"`).join('\n');
      const psPaths = [
        `$env:USERPROFILE\\.local\\bin`,
        `$env:USERPROFILE\\.myelin\\bin`,
        `$env:APPDATA\\uv\\bin`,
        `$env:LOCALAPPDATA\\uv\\bin`,
        `$env:APPDATA\\npm`,
      ].map(p => `if ($env:PATH -notlike "*${p}*") { $env:PATH = "${p};$env:PATH" }`).join('\n');
      block = `\n# >>> myelin managed >>>\n${psEnv}\n${psCert}\n${psPaths}\n${myelinCmd}\n${copilotAlias}\n${claudeAlias}\n# <<< myelin managed <<<\n`;
    } else {
      // NOTE: no ANTHROPIC_BASE_URL export — see _claude wrapper below.
      block = `\n# >>> myelin managed >>>\nexport HEADROOM_PORT=${selectedProxyPort}${certBlock}${extraPath}\n${myelinCmd}\n${copilotAlias}\n${claudeAlias}\n# <<< myelin managed <<<\n`;
    }
    const updated = existing.includes('myelin managed')
      ? existing.replace(/\n?# >>> myelin managed >>>[\s\S]*?# <<< myelin managed <<<\n?/, block)
      : existing + block;
    if (updated !== existing) {
      writeFileSync(profilePath, updated, 'utf8');
      ok(`${profilePath} (proxy, alias${certLines ? ', CA bundle env vars' : ''}, PATH, _copilot + _claude wrappers)`);
      if (os === 'windows') {
        const appData = process.env.APPDATA || join(home, 'AppData', 'Roaming');
        if (installWindowsAutoloadModule(appData, profilePath)) {
          ok('PowerShell module autoload registered (myelin/_copilot/_claude load in new windows)');
        } else {
          warn('Could not register PowerShell autoload module — run manually: Import-Module MyelinAutoload');
        }
      }
    } else {
      skip(`${profilePath} already configured`);
      if (os === 'windows') {
        const appData = process.env.APPDATA || join(home, 'AppData', 'Roaming');
        const moduleFile = join(appData, 'Microsoft', 'Windows', 'PowerShell', 'Modules', 'MyelinAutoload', 'MyelinAutoload.psm1');
        if (!existsSync(moduleFile)) {
          if (installWindowsAutoloadModule(appData, profilePath)) {
            ok('PowerShell module autoload registered (myelin/_copilot/_claude load in new windows)');
          } else {
            warn('Could not register PowerShell autoload module — run manually: Import-Module MyelinAutoload');
          }
        }
      }
    }
  }

  // Global bin — expose `myelin` via npm's own bin-linking mechanism
  // (package.json's "bin" field), the standard way to ship a Node CLI,
  // additionally to the shell alias/function above. Still just executes
  // the same source files (no bundling), so self-update via `git pull`
  // keeps working unchanged. Gracefully skipped if the npm global bin dir
  // isn't writable (some corp machines) — the shell alias/PS module above
  // remains the reliable baseline either way.
  {
    const linkResult = linkGlobalBin({ repoRoot: resolveRepoRoot(home, os).replace(/[\\/]$/, ''), os });
    if (linkResult.linked) {
      ok(`myelin linked globally via npm (${linkResult.binDir})`);
    } else {
      skip(`npm global bin link skipped (${linkResult.reason}) — using shell alias only`);
    }
  }

  // Windows: additionally persist env vars to the registry (HKCU\Environment)
  // so new windows opened from Explorer (Start Menu, taskbar) pick them up
  // immediately, even before any $PROFILE-equivalent runs — verified live
  // that Explorer-spawned processes see this, unlike SSH-spawned ones,
  // which cache their own session environment separately. Purely additive:
  // the PowerShell module above remains the primary, proven mechanism.
  //
  // CRITICAL: DO NOT add provider-specific env vars (ANTHROPIC_BASE_URL,
  // HTTPS_PROXY, ENABLE_PROMPT_CACHING_1H) to this registry map. Anything
  // set here is global to every Windows process — including Copilot CLI,
  // which respects ANTHROPIC_BASE_URL via its embedded Anthropic SDK when
  // routing Claude models. Global ANTHROPIC_BASE_URL made Copilot bypass
  // mitmproxy and hit api.anthropic.com directly (blocked by network
  // filters → 418). Provider env vars live only in _copilot / _claude
  // wrappers so they can't cross-contaminate.
  if (os === 'windows') {
    const _winCfg = await loadConfig(DEFAULT_CONFIG_PATH);
    const interceptEnabled = _winCfg.proxy?.headroom?.intercept_tool_results !== false;
    const registryVars = {
      HEADROOM_PORT: String(selectedProxyPort),
      // Use env var instead of --intercept-tool-results CLI flag to avoid startup hang:
      // the flag triggers ensure_tools() which downloads ast-grep and blocks in restricted networks.
      ...(interceptEnabled ? { HEADROOM_INTERCEPT_ENABLED: '1' } : {}),
      ...sslEnv,
    };
    if (setUserEnvVars(registryVars)) {
      ok('Env vars persisted to registry (new windows pick them up without $PROFILE)');
    } else {
      warn('Could not persist env vars to registry — relying on PowerShell module only');
    }
    // P3: clean up stale OPENAI_TARGET_URL left by old myelin versions (was
    // incorrectly set to http://127.0.0.1:8787 — circular — instead of the
    // correct upstream URL). Only remove if it points at localhost.
    try {
      execSync(
        String.raw`powershell -Command "$v = [Environment]::GetEnvironmentVariable('OPENAI_TARGET_URL','User'); if ($v -and $v -like '*127.0.0.1*') { [Environment]::SetEnvironmentVariable('OPENAI_TARGET_URL', $null, 'User'); Write-Host '[myelin] removed stale OPENAI_TARGET_URL' }"`,
        { stdio: 'inherit' }
      );
    } catch {}
    // Clean up stale OPENAI_TARGET_API_URL from prior installs. Provider target
    // URLs belong only to the specific service process that needs them, never
    // in the global User environment where Copilot CLI could inherit them.
    try {
      execSync(
        String.raw`powershell -Command "$v = [Environment]::GetEnvironmentVariable('OPENAI_TARGET_API_URL','User'); if ($v) { [Environment]::SetEnvironmentVariable('OPENAI_TARGET_API_URL', $null, 'User'); Write-Host '[myelin] removed stale OPENAI_TARGET_API_URL User env' }"`,
        { stdio: 'inherit' }
      );
    } catch {}
    // Clean up stale ANTHROPIC_BASE_URL from prior myelin installs — earlier
    // versions persisted it here globally, which made Copilot CLI bypass
    // mitmproxy. It now lives only inside the _claude wrapper.
    try {
      execSync(
        String.raw`powershell -Command "$v = [Environment]::GetEnvironmentVariable('ANTHROPIC_BASE_URL','User'); if ($v -and $v -like '*127.0.0.1*') { [Environment]::SetEnvironmentVariable('ANTHROPIC_BASE_URL', $null, 'User'); Write-Host '[myelin] removed stale ANTHROPIC_BASE_URL User env (Copilot must go through HTTPS_PROXY -> mitmproxy; Claude uses _claude wrapper)' }"`,
        { stdio: 'inherit' }
      );
    } catch {}
  }

  // 6. Hooks
  if (claudeCC) {
    step('[6/7] Hooks: managed per-project by `myelin init`');
  } else { step('[6/7] Hooks: skipped (--copilot-only)'); }

  // 7. Summary
  step('[7/7] Complete! \ud83e\uddec\n' + '\u2500'.repeat(55));
  console.log(`  Headroom port: ${port}`);
  console.log(`  Mitmproxy:     8888  (Copilot compression + cache)`);
  console.log(`  Headroom:      ${headroomBinPath()}`);
  console.log(`  Config:        ${DEFAULT_CONFIG_PATH}`);
  if (caBundles.length) console.log(`  Corporate SSL: ${caBundles[0].path}`);
  console.log('\n  myelin verify          \u2192 health check');
  console.log('  myelin config show     \u2192 view settings');
  console.log('  myelin update --check  \u2192 available updates');
  console.log('\u2500'.repeat(55) + '\n');
  _closeRL();

  // Reload shell profiles in all open terminals
  const { runReload } = await import('./cli/reload.mjs');
  await runReload();
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch(e => { _closeRL(); console.error(e); process.exit(1); });
}
