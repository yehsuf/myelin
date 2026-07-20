import { loadConfig } from '../config/reader.mjs';
import { buildEngineInstancePlan } from '../config/engine-runtime.mjs';
import { waitForHeadroom, headroomHealthUrl } from '../tools/headroom.mjs';
import { detectTool, detectRtk } from '../detect/tools.mjs';
import { engineInstanceStatus, mitmServiceStatus } from '../service/index.mjs';
import { detectRtkHookArtifacts, formatRtkVersionDetail } from '../tools/rtk.mjs';
import { which } from '../detect/which.mjs';
import { ensureToolPath } from '../detect/tool-path.mjs';
import { detectOS } from '../detect/os.mjs';
import { execSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { managedPaths } from '../shared/myelin-paths.mjs';

async function probeHeadroomLite(port, execSyncFn = execSync) {
  try {
    return JSON.parse(execSyncFn(`curl -sf --max-time 3 http://127.0.0.1:${port}/health`, { timeout: 4000 }).toString());
  } catch {
    return null;
  }
}

export function printVerifyEnvironmentNote({ detectOSImpl = detectOS, log = console.log } = {}) {
  if (detectOSImpl(true).wsl) {
    log('ℹ Detected: running inside WSL — bridging to Windows service management via PowerShell interop.');
  }
}

function engineInstanceLabel({ engine, role }) {
  const base = engine === 'headroom_lite' ? 'Headroom Lite' : 'Headroom';
  return role === 'copilot' ? `Copilot ${base}` : base;
}

async function probeEngineInstance(instance, {
  winManager,
  engineInstanceStatusImpl,
  waitForHeadroomImpl,
  probeHeadroomLiteImpl,
}) {
  const label = engineInstanceLabel(instance);
  const service = await engineInstanceStatusImpl(instance, { manager: winManager });
  const results = [{
    name: `${label} service`,
    ok: service.running,
    detail: service.running
      ? `running${service.label ? ` (${service.label})` : ''}`
      : 'not running — try: myelin diagnose',
  }];

  if (instance.engine === 'headroom_lite') {
    const response = await probeHeadroomLiteImpl(instance.port);
    const healthy = response?.status === 'ok';
    results.push({
      name: `${label} health`,
      ok: healthy,
      detail: healthy ? `running — mode: ${response.mode}` : 'not running — run: myelin restart',
    });
  } else {
    const healthy = await waitForHeadroomImpl(instance.port, 3000);
    results.push({
      name: `${label} health`,
      ok: healthy,
      detail: healthy ? headroomHealthUrl(instance.port) : `no response on :${instance.port}`,
    });
  }

  return results;
}

/**
 * Check that current.json releaseId matches the current symlink target,
 * and that the release directory actually exists with a valid entrypoint.
 * Returns a verify result object.
 */
export function checkManagedRuntime({ home = homedir(), env = process.env, existsSyncImpl = existsSync, readFileSyncImpl = readFileSync } = {}) {
  const root = managedPaths({ home, env }).root;
  const currentJsonPath = join(root, 'current.json');
  const currentSymlink = join(root, 'current');

  if (!existsSyncImpl(currentJsonPath)) {
    return { name: 'Managed runtime', ok: true, detail: 'unmanaged (direct install)' };
  }

  let currentJson;
  try {
    currentJson = JSON.parse(readFileSyncImpl(currentJsonPath, 'utf8'));
  } catch {
    return { name: 'Managed runtime', ok: false, detail: `current.json unreadable — run: myelin update` };
  }

  const { releaseId, runtimeRoot } = currentJson;

  // Check the release dir exists
  if (!runtimeRoot || !existsSyncImpl(runtimeRoot)) {
    return {
      name: 'Managed runtime',
      ok: false,
      detail: `release dir missing: ${runtimeRoot ?? releaseId} — run: myelin update --channel main`,
    };
  }

  // Check the entrypoint exists inside the release
  const entrypoint = join(runtimeRoot, 'src', 'cli', 'index.mjs');
  if (!existsSyncImpl(entrypoint)) {
    return {
      name: 'Managed runtime',
      ok: false,
      detail: `entrypoint missing in release ${releaseId} — run: myelin update --channel main`,
    };
  }

  // Check symlink points to the same release as current.json
  try {
    const symlinkTarget = realpathSync(currentSymlink);
    const jsonTarget = runtimeRoot.replace(/\/$/, '');
    if (symlinkTarget !== jsonTarget) {
      return {
        name: 'Managed runtime',
        ok: false,
        detail: `current.json (${releaseId}) ≠ current symlink — run: myelin update --channel main`,
      };
    }
  } catch {
    // symlink missing or unresolvable — not necessarily fatal if json+dir are fine
  }

  return { name: 'Managed runtime', ok: true, detail: `${releaseId.slice(0, 20)}… healthy` };
}


export async function buildVerifyResults({
  config,
  loadConfigImpl = loadConfig,
  waitForHeadroomImpl = waitForHeadroom,
  engineInstanceStatusImpl = engineInstanceStatus,
  mitmServiceStatusImpl = mitmServiceStatus,
  detectToolImpl = detectTool,
  detectRtkImpl = detectRtk,
  detectSembleImpl,
  whichImpl = which,
  probeHeadroomLiteImpl = (port) => probeHeadroomLite(port),
  includeToolChecks = true,
  includeMitmCheck = true,
  includeCopilotHeadroomCheck = true,
  includeWatchdogChecks = true,
  includeManagedRuntimeCheck = true,
  platform = process.platform,
  execSyncImpl = execSync,
} = {}) {
  const cfg = config ?? await loadConfigImpl();
  const mitmPort = cfg.proxy?.mitm?.port ?? 8888;
  const winManager = cfg.proxy?.windows_service?.manager ?? 'registry';

  let plannedEngineInstances;
  try {
    plannedEngineInstances = buildEngineInstancePlan(cfg).instances;
  } catch (err) {
    return [{ name: 'Engine plan', ok: false, detail: `config error: ${err.message}` }];
  }

  const engineInstances = plannedEngineInstances
    .filter((instance) => instance.role !== 'copilot' || includeCopilotHeadroomCheck);
  const results = [];

  // Check managed runtime consistency first — a broken current.json makes
  // every subsequent myelin command fail with an opaque "entrypoint missing" error.
  if (includeManagedRuntimeCheck && platform !== 'win32') {
    results.push(checkManagedRuntime());
  }

  for (const instance of engineInstances) {
    results.push(...await probeEngineInstance(instance, {
      winManager,
      engineInstanceStatusImpl,
      waitForHeadroomImpl,
      probeHeadroomLiteImpl,
    }));
  }

  // If copilot_proxy is explicitly disabled, add an honest row instead of
  // silently omitting it (verify should never show all-green while Copilot
  // traffic falls back to sidecar-only compression).
  const copilotDisabled = !(cfg.proxy?.copilot_headroom?.enabled ?? true);
  const copilotInPlan = plannedEngineInstances.some(i => i.role === 'copilot');
  if (copilotDisabled && !copilotInPlan) {
    results.push({
      name: 'Copilot proxy',
      ok: false,
      detail: 'disabled — Copilot uses sidecar compress only (enable: myelin config set proxy.copilot_headroom.enabled true && myelin install)',
    });
  }

  if (includeMitmCheck && cfg.proxy?.mitm?.enabled) {
    const mitmSvc = await mitmServiceStatusImpl({ manager: winManager });
    const mitmdump = await whichImpl('mitmdump');
    results.push({
      name: `Mitmproxy service (:${mitmPort})`,
      ok: mitmSvc.running,
      detail: mitmSvc.running
        ? `running${mitmdump ? ` (${mitmdump})` : ''}`
        : mitmdump ? 'not running — try: myelin diagnose' : 'mitmdump not found — run: myelin update',
    });
  }

  if (includeWatchdogChecks && platform === 'darwin') {
    try {
      execSyncImpl('launchctl list com.myelin.watchdog', { stdio: 'ignore' });
      results.push({ name: 'Watchdog', ok: true, detail: 'active — checks every 90s' });
    } catch {
      results.push({ name: 'Watchdog', ok: false, detail: 'not registered — run: myelin update (or reinstall)' });
    }
  }

  if (includeWatchdogChecks && platform === 'win32' && winManager === 'winsw' && cfg.proxy?.windows_service?.watchdog_enabled) {
    const { windowsWatchdogTaskName } = await import('../service/windows.mjs');
    const interval = Number(cfg.proxy.windows_service.watchdog_interval_minutes ?? 2) || 2;
    const taskNames = plannedEngineInstances.map(({ id }) => windowsWatchdogTaskName({ id }));
    for (const taskName of taskNames) {
      try {
        execSyncImpl(`schtasks /query /tn "${taskName}"`, { stdio: 'ignore' });
        results.push({ name: taskName, ok: true, detail: `scheduled — checks every ${interval} minute${interval === 1 ? '' : 's'}` });
      } catch {
        results.push({ name: taskName, ok: false, detail: 'not registered — run: myelin update (or reinstall)' });
      }
    }
  }

  if (includeToolChecks) {
    for (const tool of ['uv', 'serena']) {
      const r = await detectToolImpl(tool, '--version');
      results.push({ name: tool, ok: r.installed, detail: r.installed ? r.version : 'not found — run: myelin update' });
    }
    if (cfg.shell_compression?.rtk !== false) {
      const rtk = await detectRtkImpl();
      results.push({ name: 'rtk', ok: rtk.installed, detail: formatRtkVersionDetail(rtk) });
      if (rtk.installed) {
        const hookState = detectRtkHookArtifacts();
        if (hookState.claude.relevant) {
          results.push({ name: 'RTK Claude hook', ok: hookState.claude.ok, detail: hookState.claude.detail });
        }
        if (hookState.copilot.relevant) {
          results.push({ name: 'RTK Copilot hook', ok: hookState.copilot.ok, detail: hookState.copilot.detail });
        }
      }
    }
    const astgrep = await (async () => {
      const r = await detectToolImpl('ast-grep', '--version');
      return r.installed ? r : detectToolImpl('sg', '--version');
    })();
    results.push({ name: 'ast-grep', ok: astgrep.installed, detail: astgrep.installed ? astgrep.version : 'not found — run: myelin update' });
    const detectSemble = detectSembleImpl ?? (await import('../detect/tools.mjs')).detectSemble;
    const semble = await detectSemble();
    results.push({ name: 'semble', ok: semble.installed, detail: semble.installed ? semble.version : 'not found — run: myelin update' });
  }

  return results;
}

export async function runVerify(options = {}) {
  ensureToolPath();
  const log = options.log ?? console.log;
  const results = await buildVerifyResults(options);
  const width = Math.max(...results.map(r => r.name.length));
  printVerifyEnvironmentNote({ detectOSImpl: options.detectOSImpl, log });
  log('\nMyelin Component Status\n' + '─'.repeat(60));
  for (const r of results) {
    log(`  ${r.ok ? '✓' : '✗'} ${r.name.padEnd(width + 2)} ${r.detail}`);
  }
  log('─'.repeat(60));
  log(`  ${results.filter(r => r.ok).length}/${results.length} components healthy\n`);
  return results.every(r => r.ok);
}
