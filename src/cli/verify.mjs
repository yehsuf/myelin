import { loadConfig } from '../config/reader.mjs';
import { selectedEngine } from '../config/engine-runtime.mjs';
import { waitForHeadroom, headroomHealthUrl } from '../tools/headroom.mjs';
import { detectTool, detectRtk } from '../detect/tools.mjs';
import { serviceStatus, mitmServiceStatus, copilotHeadroomServiceStatus } from '../service/index.mjs';
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

export async function buildVerifyResults({
  config,
  loadConfigImpl = loadConfig,
  waitForHeadroomImpl = waitForHeadroom,
  serviceStatusImpl = serviceStatus,
  mitmServiceStatusImpl = mitmServiceStatus,
  copilotHeadroomServiceStatusImpl = copilotHeadroomServiceStatus,
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
} = {}) {
  const cfg = config ?? await loadConfigImpl();
  const port = cfg.proxy.headroom.port;
  const mitmPort = cfg.proxy?.mitm?.port ?? 8888;
  const winManager = cfg.proxy?.windows_service?.manager ?? 'registry';
  const results = [];

  if (selectedEngine(cfg) === 'headroom_lite') {
    const hlPort = cfg?.proxy?.headroom_lite?.port ?? 8790;
    const hlResp = await probeHeadroomLiteImpl(hlPort);
    results.push({
      name: `headroom-lite (:${hlPort})`,
      ok: hlResp?.status === 'ok',
      detail: hlResp?.status === 'ok' ? `running — mode: ${hlResp.mode}` : 'not running — run: myelin restart',
    });
  } else if (cfg.proxy?.headroom?.enabled) {
    const svc = await serviceStatusImpl({ manager: winManager });
    results.push({
      name: 'Headroom service',
      ok: svc.running,
      detail: svc.running ? `running${svc.label ? ` (${svc.label})` : ''}` : 'not running — try: myelin diagnose',
    });

    const healthy = await waitForHeadroomImpl(port, 3000);
    results.push({
      name: `Headroom health (:${port})`,
      ok: healthy,
      detail: healthy ? headroomHealthUrl(port) : `no response on :${port}`,
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
      execSync('launchctl list com.myelin.watchdog', { stdio: 'ignore' });
      results.push({ name: 'Watchdog', ok: true, detail: 'active — checks every 90s' });
    } catch {
      results.push({ name: 'Watchdog', ok: false, detail: 'not registered — run: myelin update (or reinstall)' });
    }
  }

  if (includeWatchdogChecks && platform === 'win32' && winManager === 'winsw' && cfg.proxy?.windows_service?.watchdog_enabled) {
    const { HEADROOM_SERVICE_ID, COPILOT_HEADROOM_SERVICE_ID, windowsWatchdogTaskName } = await import('../service/windows.mjs');
    const interval = Number(cfg.proxy.windows_service.watchdog_interval_minutes ?? 2) || 2;
    const taskNames = [
      ...(selectedEngine(cfg) === 'headroom' ? [windowsWatchdogTaskName({ id: HEADROOM_SERVICE_ID })] : []),
      ...(cfg.proxy?.copilot_headroom?.enabled ? [windowsWatchdogTaskName({ id: COPILOT_HEADROOM_SERVICE_ID })] : []),
    ];
    for (const taskName of taskNames) {
      try {
        execSync(`schtasks /query /tn "${taskName}"`, { stdio: 'ignore' });
        results.push({ name: taskName, ok: true, detail: `scheduled — checks every ${interval} minute${interval === 1 ? '' : 's'}` });
      } catch {
        results.push({ name: taskName, ok: false, detail: 'not registered — run: myelin update (or reinstall)' });
      }
    }
  }

  if (includeCopilotHeadroomCheck && cfg.proxy?.copilot_headroom?.enabled) {
    const copilotHeadroomPort = cfg.proxy.copilot_headroom.port ?? 8788;
    const chSvc = await copilotHeadroomServiceStatusImpl({ manager: winManager });
    results.push({
      name: 'Copilot-Headroom service',
      ok: chSvc.running,
      detail: chSvc.running ? `running${chSvc.label ? ` (${chSvc.label})` : ''}` : 'not running — try: myelin diagnose',
    });
    const chHealthy = await waitForHeadroomImpl(copilotHeadroomPort, 3000);
    results.push({
      name: `Copilot-Headroom health (:${copilotHeadroomPort})`,
      ok: chHealthy,
      detail: chHealthy ? headroomHealthUrl(copilotHeadroomPort) : `no response on :${copilotHeadroomPort}`,
    });
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
