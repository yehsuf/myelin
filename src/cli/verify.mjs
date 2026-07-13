import { loadConfig } from '../config/reader.mjs';
import { waitForHeadroom, headroomHealthUrl } from '../tools/headroom.mjs';
import { detectTool, detectRtk } from '../detect/tools.mjs';
import { serviceStatus, mitmServiceStatus, copilotHeadroomServiceStatus } from '../service/index.mjs';
import { detectRtkHookArtifacts, formatRtkVersionDetail } from '../tools/rtk.mjs';
import { which } from '../detect/which.mjs';
import { ensureToolPath } from '../detect/tool-path.mjs';
import { detectOS } from '../detect/os.mjs';
import { execSync } from 'node:child_process';

export function printVerifyEnvironmentNote({ detectOSImpl = detectOS, log = console.log } = {}) {
  if (detectOSImpl(true).wsl) {
    log('ℹ Detected: running inside WSL — bridging to Windows service management via PowerShell interop.');
  }
}

export async function runVerify() {
  ensureToolPath();
  const cfg = await loadConfig();
  const port = cfg.proxy.headroom.port;
  const mitmPort = cfg.proxy?.mitm?.port ?? 8888;
  const winManager = cfg.proxy?.windows_service?.manager ?? 'registry';
  const results = [];

  // headroom-lite (replaces old headroom — always checked)
  const hlPort = cfg?.proxy?.headroom_lite?.port ?? 8790;
  try {
    const hlResp = JSON.parse(execSync(`curl -sf --max-time 3 http://127.0.0.1:${hlPort}/health`, { timeout: 4000 }).toString());
    results.push({
      name: `headroom-lite (:${hlPort})`,
      ok: hlResp?.status === 'ok',
      detail: hlResp?.status === 'ok' ? `running — mode: ${hlResp.mode}` : 'unexpected response',
    });
  } catch {
    results.push({ name: `headroom-lite (:${hlPort})`, ok: false, detail: `not running — run: myelin restart` });
  }

  // Old headroom (opt-in via proxy.headroom.enabled — skipped entirely when
  // disabled, so a machine that has intentionally turned it off doesn't
  // show a confusing failing row; matches the copilot_headroom pattern below).
  if (cfg.proxy?.headroom?.enabled) {
    const svc = await serviceStatus({ manager: winManager });
    results.push({
      name: 'Headroom service',
      ok: svc.running,
      detail: svc.running
        ? `running${svc.label ? ` (${svc.label})` : ''}`
        : 'not running — try: myelin diagnose',
    });

    const healthy = await waitForHeadroom(port, 3000);
    results.push({
      name: `Headroom health (:${port})`,
      ok: healthy,
      detail: healthy ? headroomHealthUrl(port) : `no response on :${port}`,
    });
  }

  // Mitmproxy (opt-in via proxy.mitm.enabled — same reasoning as above).
  if (cfg.proxy?.mitm?.enabled) {
    const mitmSvc = await mitmServiceStatus({ manager: winManager });
    const mitmdump = await which('mitmdump');
    results.push({
      name: `Mitmproxy service (:${mitmPort})`,
      ok: mitmSvc.running,
      detail: mitmSvc.running
        ? `running${mitmdump ? ` (${mitmdump})` : ''}`
        : mitmdump ? 'not running — try: myelin diagnose' : 'mitmdump not found — run: myelin update',
    });
  }

  // Watchdog — macOS uses launchd; Windows can opt into Scheduled Tasks,
  // but only meaningful once proxy.windows_service.manager is 'winsw'
  // (registry-based installs have no WinSW service for the watchdog to
  // restart, so there's nothing to check).
  if (process.platform === 'darwin') {
    try {
      const { execSync } = await import('node:child_process');
      execSync(`launchctl list com.myelin.watchdog`, { stdio: 'ignore' });
      results.push({ name: 'Watchdog', ok: true, detail: 'active — checks every 90s' });
    } catch {
      results.push({ name: 'Watchdog', ok: false, detail: 'not registered — run: myelin update (or reinstall)' });
    }
  }
  if (process.platform === 'win32' && winManager === 'winsw' && cfg.proxy?.windows_service?.watchdog_enabled) {
    const { HEADROOM_SERVICE_ID, COPILOT_HEADROOM_SERVICE_ID, windowsWatchdogTaskName } = await import('../service/windows.mjs');
    const interval = Number(cfg.proxy.windows_service.watchdog_interval_minutes ?? 2) || 2;
    const taskNames = [
      windowsWatchdogTaskName({ id: HEADROOM_SERVICE_ID }),
      ...(cfg.proxy?.copilot_headroom?.enabled ? [windowsWatchdogTaskName({ id: COPILOT_HEADROOM_SERVICE_ID })] : []),
    ];
    for (const taskName of taskNames) {
      try {
        execSync(`schtasks /query /tn "${taskName}"`, { stdio: 'ignore' });
        results.push({ name: `${taskName}`, ok: true, detail: `scheduled — checks every ${interval} minute${interval === 1 ? '' : 's'}` });
      } catch {
        results.push({ name: `${taskName}`, ok: false, detail: 'not registered — run: myelin update (or reinstall)' });
      }
    }
  }

  // Copilot-Headroom (opt-in — only checked when enabled in config, so this
  // doesn't show a confusing failing row for installs that haven't opted in)
  if (cfg.proxy?.copilot_headroom?.enabled) {
    const copilotHeadroomPort = cfg.proxy.copilot_headroom.port ?? 8788;
    const chSvc = await copilotHeadroomServiceStatus({ manager: winManager });
    results.push({
      name: 'Copilot-Headroom service',
      ok: chSvc.running,
      detail: chSvc.running ? `running${chSvc.label ? ` (${chSvc.label})` : ''}` : 'not running — try: myelin diagnose',
    });
    const chHealthy = await waitForHeadroom(copilotHeadroomPort, 3000);
    results.push({
      name: `Copilot-Headroom health (:${copilotHeadroomPort})`,
      ok: chHealthy,
      detail: chHealthy ? headroomHealthUrl(copilotHeadroomPort) : `no response on :${copilotHeadroomPort}`,
    });
  }

  for (const tool of ['uv', 'serena']) {
    const r = await detectTool(tool, '--version');
    results.push({ name: tool, ok: r.installed, detail: r.installed ? r.version : 'not found — run: myelin update' });
  }
  if (cfg.shell_compression?.rtk !== false) {
    const rtk = await detectRtk();
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
  // ast-grep may be installed as 'sg' (npm) or 'ast-grep' (cargo/brew)
  const astgrep = await (async () => {
    const r = await detectTool('ast-grep', '--version');
    return r.installed ? r : detectTool('sg', '--version');
  })();
  results.push({ name: 'ast-grep', ok: astgrep.installed, detail: astgrep.installed ? astgrep.version : 'not found — run: myelin update' });
  // semble uses subcommands, not --version
  const { detectSemble } = await import('../detect/tools.mjs');
  const semble = await detectSemble();
  results.push({ name: 'semble', ok: semble.installed, detail: semble.installed ? semble.version : 'not found — run: myelin update' });

  const width = Math.max(...results.map(r => r.name.length));
  printVerifyEnvironmentNote();
  console.log('\nMyelin Component Status\n' + '─'.repeat(60));
  for (const r of results) {
    console.log(`  ${r.ok ? '✓' : '✗'} ${r.name.padEnd(width + 2)} ${r.detail}`);
  }
  console.log('─'.repeat(60));
  const passed = results.filter(r => r.ok).length;
  console.log(`  ${passed}/${results.length} components healthy\n`);
  return results.every(r => r.ok);
}
