import { loadConfig } from '../config/reader.mjs';
import { waitForHeadroom, headroomHealthUrl } from '../tools/headroom.mjs';
import { detectTool, detectRtk } from '../detect/tools.mjs';
import { serviceStatus, mitmServiceStatus, copilotHeadroomServiceStatus } from '../service/index.mjs';
import { detectRtkHookArtifacts, formatRtkVersionDetail } from '../tools/rtk.mjs';
import { which } from '../detect/which.mjs';
import { homedir } from 'node:os';
import { join } from 'node:path';

function ensureWindowsPath() {
  if (process.platform !== 'win32') return;
  const home = homedir();
  const extra = [
    join(home, '.local', 'bin'),
    join(home, '.myelin', 'bin'),
    join(home, 'AppData', 'Roaming', 'uv', 'bin'),
    join(home, 'AppData', 'Local', 'uv', 'bin'),
    join(home, 'AppData', 'Roaming', 'npm'),           // npm global bin on Windows
    join(home, 'AppData', 'Local', 'npm'),
    ...[...Array(8)].map((_, i) => join(home, 'AppData', 'Roaming', 'Python', `Python3${10+i}`, 'Scripts')),
    ...[...Array(8)].map((_, i) => join(home, 'AppData', 'Local', 'Programs', 'Python', `Python3${10+i}`, 'Scripts')),
  ];
  // Also detect nvm/nvm4w managed node bin dirs dynamically
  try {
    const nvmDir = process.env.NVM_HOME || process.env.NVM_SYMLINK;
    if (nvmDir) extra.push(nvmDir);
    const nvm4w = process.env.NVM4W_HOME;
    if (nvm4w) extra.push(join(nvm4w, 'nodejs'));
    // Always include the directory where node.exe itself lives (covers nvm4w, nvm, portable)
    const nodeDir = join(process.execPath, '..');
    if (!extra.includes(nodeDir)) extra.push(nodeDir);
  } catch {}
  for (const p of extra) {
    if (!process.env.PATH?.includes(p)) process.env.PATH = p + ';' + (process.env.PATH || '');
  }
}

export async function runVerify() {
  ensureWindowsPath();
  const cfg = await loadConfig();
  const port = cfg.proxy.headroom.port;
  const mitmPort = cfg.proxy?.mitm?.port ?? 8888;
  const results = [];

  // Headroom (opt-in via proxy.headroom.enabled — skipped entirely when
  // disabled, so a machine that has intentionally turned it off doesn't
  // show a confusing failing row; matches the copilot_headroom pattern below).
  if (cfg.proxy?.headroom?.enabled) {
    const svc = await serviceStatus();
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
    const mitmSvc = await mitmServiceStatus();
    const mitmdump = await which('mitmdump');
    results.push({
      name: `Mitmproxy service (:${mitmPort})`,
      ok: mitmSvc.running,
      detail: mitmSvc.running
        ? `running${mitmdump ? ` (${mitmdump})` : ''}`
        : mitmdump ? 'not running — try: myelin diagnose' : 'mitmdump not found — run: myelin update',
    });
  }

  // Watchdog (macOS only) — auto-revives services if launchd silently drops them
  if (process.platform === 'darwin') {
    try {
      const { execSync } = await import('node:child_process');
      execSync(`launchctl list com.myelin.watchdog`, { stdio: 'ignore' });
      results.push({ name: 'Watchdog', ok: true, detail: 'active — checks every 90s' });
    } catch {
      results.push({ name: 'Watchdog', ok: false, detail: 'not registered — run: myelin update (or reinstall)' });
    }
  }

  // Copilot-Headroom (opt-in — only checked when enabled in config, so this
  // doesn't show a confusing failing row for installs that haven't opted in)
  if (cfg.proxy?.copilot_headroom?.enabled) {
    const copilotHeadroomPort = cfg.proxy.copilot_headroom.port ?? 8788;
    const chSvc = await copilotHeadroomServiceStatus();
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
  const { detectSemble, detectHeadroom } = await import('../detect/tools.mjs');
  const semble = await detectSemble();
  results.push({ name: 'semble', ok: semble.installed, detail: semble.installed ? semble.version : 'not found — run: myelin update' });
  const hr = await detectHeadroom();
  results.push({ name: 'headroom proxy', ok: hr.installed, detail: hr.installed ? hr.version : 'not found in venv — run: myelin update' });

  const width = Math.max(...results.map(r => r.name.length));
  console.log('\nMyelin Component Status\n' + '─'.repeat(60));
  for (const r of results) {
    console.log(`  ${r.ok ? '✓' : '✗'} ${r.name.padEnd(width + 2)} ${r.detail}`);
  }
  console.log('─'.repeat(60));
  const passed = results.filter(r => r.ok).length;
  console.log(`  ${passed}/${results.length} components healthy\n`);
  return results.every(r => r.ok);
}
