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
  platform = process.platform,
  execSyncImpl = execSync,
} = {}) {
  const cfg = config ?? await loadConfigImpl();
  const mitmPort = cfg.proxy?.mitm?.port ?? 8888;
  const winManager = cfg.proxy?.windows_service?.manager ?? 'registry';
  const plannedEngineInstances = buildEngineInstancePlan(cfg).instances;
  const engineInstances = plannedEngineInstances
    .filter((instance) => instance.role !== 'copilot' || includeCopilotHeadroomCheck);
  const results = [];

  for (const instance of engineInstances) {
    results.push(...await probeEngineInstance(instance, {
      winManager,
      engineInstanceStatusImpl,
      waitForHeadroomImpl,
      probeHeadroomLiteImpl,
    }));
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
