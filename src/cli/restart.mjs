import { execSync, spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync, readdirSync, existsSync, writeFileSync, unlinkSync } from 'node:fs';
import { detectOS } from '../detect/os.mjs';
import { selectedEngine } from '../config/engine-runtime.mjs';
import { waitForHeadroom, headroomBinPath } from '../tools/headroom.mjs';
import { loadConfig } from '../config/reader.mjs';
import { buildServiceEnvUnsetLines } from '../service/wrappers.mjs';

const COPILOT_HEADROOM_RUN_KEY = 'MyelinCopilotHeadroom';
const REG_RUN = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';

function escapePs(value = '') {
  return String(value ?? '').replace(/'/g, "''");
}

function windowsPath(value = '') {
  return String(value ?? '').replace(/\//g, '\\');
}

/**
 * Start (or restart) headroom-lite on the given port.
 *
 * Cross-platform:
 *   - Uses `shell: true` so we resolve npm-global shims (headroom-lite.cmd on
 *     Windows, /usr/local/bin/headroom-lite on macOS/Linux) without hardcoding.
 *   - Detaches + unref()s so the process outlives the current `myelin restart`
 *     invocation, mirroring how the copilot-headroom Task Scheduler task
 *     already behaves on Windows.
 *   - Passes HEADROOM_LITE_PORT explicitly so port is deterministic even if
 *     the user's shell has a different default set.
 *   - Fails soft when the binary isn't installed (prints a hint) — this is
 *     currently an optional service, not a hard dependency of `myelin restart`.
 */
export async function restartHeadroomLite(port, osKind) {
  // Best-effort probe: is the binary available? Using shell so npm shims work.
  const probeCmd = osKind === 'windows'
    ? `powershell -Command "if (Get-Command headroom-lite -ErrorAction SilentlyContinue) { exit 0 } else { exit 1 }"`
    : `command -v headroom-lite >/dev/null 2>&1`;
  try {
    execSync(probeCmd, { stdio: 'pipe' });
  } catch {
    console.log('  ↷ headroom-lite not installed — run: npm i -g @yehsuf/headroom-lite');
    return false;
  }

  // Kill any existing headroom-lite process on this port so we don't collide.
  if (osKind === 'windows') {
    try {
      execSync(
        `powershell -Command "Get-NetTCPConnection -LocalPort ${port} -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }"`,
        { stdio: 'pipe' }
      );
    } catch {}
  } else {
    try {
      execSync(`lsof -ti :${port} | xargs -r kill -9 2>/dev/null`, { stdio: 'pipe', shell: '/bin/bash' });
    } catch {}
  }
  await new Promise(r => setTimeout(r, 400));

  // Detached spawn — survives the current `myelin restart` invocation.
  // NB: we deliberately do NOT set ANTHROPIC_BASE_URL / HTTPS_PROXY in the child
  // env. headroom-lite is a server, not a client — see src/service/wrappers.mjs
  // SERVER_FORBIDDEN_ENV for the full list of vars that must not leak in.
  const childEnv = { ...process.env, HEADROOM_LITE_PORT: String(port) };
  delete childEnv.ANTHROPIC_BASE_URL;
  delete childEnv.HTTPS_PROXY;
  delete childEnv.HTTP_PROXY;
  delete childEnv.NO_PROXY;

  try {
    const child = spawn('headroom-lite', [], {
      detached: true,
      stdio: 'ignore',
      shell: true,
      env: childEnv,
    });
    child.unref();
    console.log(`  ✓ headroom-lite started (:${port})`);
  } catch (e) {
    console.warn(`  ⚠ headroom-lite start failed: ${e?.message?.split('\n')[0] ?? e}`);
    return false;
  }

  // Quick health probe — headroom-lite is a small Node.js server, usually up
  // in <1s. Don't block for long.
  const healthy = await waitForHeadroomLite(port, 5000);
  if (healthy) {
    console.log(`  ✓ headroom-lite healthy on :${port}`);
  } else {
    console.log(`  ↷ headroom-lite still starting — run: myelin verify to confirm`);
  }
  return healthy;
}

/** Reuse waitForHeadroom's polling loop but target headroom-lite's /health path. */
async function waitForHeadroomLite(port, timeoutMs = 5000) {
  const url = `http://127.0.0.1:${port}/health`;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(500) });
      if (res.ok) return true;
    } catch {}
    await new Promise(r => setTimeout(r, 100));
  }
  return false;
}

export function buildCopilotHeadroomTaskEnv({
  home = homedir(),
  copilotPort = 8788,
  egressPort = 8889,
  mode = 'cache',
} = {}) {
  const loopbackTarget = `http://127.0.0.1:${egressPort}`;
  return {
    HEADROOM_WORKSPACE_DIR: join(home, '.myelin', `headroom-copilot-${copilotPort}`),
    ANTHROPIC_TARGET_API_URL: loopbackTarget,
    OPENAI_TARGET_API_URL: loopbackTarget,
    HEADROOM_MODE: mode,
    NO_PROXY: '127.0.0.1,localhost,::1',
  };
}

function copilotHeadroomLauncherScript({ headroomBin, argStr, workingDirectory, envVars }) {
  const envLines = Object.entries(envVars)
    .filter(([, value]) => value != null && String(value).length > 0)
    .map(([key, value]) => `[System.Environment]::SetEnvironmentVariable('${key}', '${escapePs(String(value))}', 'Process')`)
    .join('\n');
  return `
# Managed by myelin. Keeps Copilot-Headroom env scoped to this process tree.
${buildServiceEnvUnsetLines({ os: 'windows' })}
${envLines}
Start-Process -FilePath '${escapePs(windowsPath(headroomBin))}' -ArgumentList '${escapePs(argStr)}' -WorkingDirectory '${escapePs(windowsPath(workingDirectory))}' -WindowStyle Hidden
`.trim();
}

function persistCopilotHeadroomLauncher({ headroomBin, argStr, taskEnv }) {
  const workingDirectory = taskEnv.HEADROOM_WORKSPACE_DIR;
  mkdirSync(workingDirectory, { recursive: true });
  const launcherPath = join(workingDirectory, 'start-copilot-headroom.ps1');
  writeFileSync(launcherPath, copilotHeadroomLauncherScript({
    headroomBin,
    argStr,
    workingDirectory,
    envVars: taskEnv,
  }), 'utf8');
  const runValue = `powershell.exe -NoProfile -ExecutionPolicy Bypass -File "${windowsPath(launcherPath)}"`;
  execSync(
    `powershell -NoProfile -Command "Set-ItemProperty -Path '${REG_RUN}' -Name '${COPILOT_HEADROOM_RUN_KEY}' -Value '${escapePs(runValue)}'"`,
    { stdio: 'pipe' },
  );
  return { exe: 'powershell.exe', args: `-NoProfile -ExecutionPolicy Bypass -File "${windowsPath(launcherPath)}"` };
}

function stopProcessByPort(port, osKind, execSyncFn = execSync) {
  if (osKind === 'windows') {
    try {
      execSyncFn(
        `powershell -Command "Get-NetTCPConnection -LocalPort ${port} -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }"`,
        { stdio: 'pipe' },
      );
    } catch {}
    return;
  }
  try {
    execSyncFn(`lsof -ti :${port} | xargs -r kill -9 2>/dev/null`, { stdio: 'pipe', shell: '/bin/bash' });
  } catch {}
}

async function stopObsoleteEngine({ engine, os, cfg, winManager }) {
  if (engine === 'headroom_lite') {
    stopProcessByPort(cfg?.proxy?.headroom_lite?.port ?? 8790, os);
    return;
  }
  if (engine !== 'headroom') return;
  if (os === 'darwin') {
    try {
      const uid = execSync('id -u').toString().trim();
      execSync(`launchctl bootout gui/${uid}/com.myelin.headroom`, { stdio: 'ignore' });
    } catch {}
    try {
      const plist = join(homedir(), 'Library', 'LaunchAgents', 'com.myelin.headroom.plist');
      if (existsSync(plist)) unlinkSync(plist);
    } catch {}
    return;
  }
  if (os === 'linux') {
    try {
      execSync('systemctl --user disable --now myelin-headroom.service', { stdio: 'pipe' });
    } catch {}
    try {
      const unit = join(homedir(), '.config', 'systemd', 'user', 'myelin-headroom.service');
      if (existsSync(unit)) unlinkSync(unit);
    } catch {}
    try {
      execSync('systemctl --user daemon-reload', { stdio: 'pipe' });
    } catch {}
    return;
  }
  if (winManager === 'winsw') {
    try {
      const { HEADROOM_SERVICE_ID, uninstallWinswService } = await import('../service/windows.mjs');
      uninstallWinswService({ id: HEADROOM_SERVICE_ID });
    } catch {}
    return;
  }
  stopProcessByPort(cfg?.proxy?.headroom?.port ?? 8787, os);
  try {
    execSync(
      `powershell -NoProfile -Command "Remove-ItemProperty -Path '${REG_RUN}' -Name 'MyelinHeadroom' -ErrorAction SilentlyContinue"`,
      { stdio: 'pipe' },
    );
  } catch {}
}

async function defaultRestartManagedHeadroom({ os, cfg, winManager, log, warn }) {
  try {
    if (os === 'darwin') {
      const uid = execSync('id -u').toString().trim();
      const plist = join(homedir(), 'Library', 'LaunchAgents', 'com.myelin.headroom.plist');
      try { execSync(`launchctl bootout gui/${uid}/com.myelin.headroom`, { stdio: 'ignore' }); } catch {}
      execSync('sleep 1');
      execSync(`launchctl bootstrap gui/${uid} ${plist}`, { stdio: 'pipe' });
      log('  ✓ headroom restarted (launchd)');
      return;
    }
    if (os === 'linux') {
      execSync('systemctl --user restart myelin-headroom.service', { stdio: 'pipe' });
      log('  ✓ headroom restarted (systemd)');
      return;
    }
    if (winManager === 'winsw') {
      const { HEADROOM_SERVICE_ID, restartWinswService } = await import('../service/windows.mjs');
      if (!restartWinswService({ id: HEADROOM_SERVICE_ID })) throw new Error('WinSW restart failed');
      log('  ✓ headroom restarted (WinSW)');
      return;
    }
    const port = cfg?.proxy?.headroom?.port ?? 8787;
    stopProcessByPort(port, os);
    await new Promise(r => setTimeout(r, 500));
    const { spawnDetachedService } = await import('../service/windows.mjs');
    spawnDetachedService('MyelinHeadroom', headroomBinPath(), `proxy --port ${port}`);
    log('  ✓ headroom restarted');
  } catch (e) {
    warn(`  ⚠ headroom restart failed: ${e.message?.split('\n')[0] ?? e}`);
  }
}

async function defaultRestartCopilotHeadroom({ os, cfg, winManager, log, warn }) {
  if (!cfg?.proxy?.copilot_headroom?.enabled) return;
  const port = cfg?.proxy?.copilot_headroom?.port ?? 8788;
  try {
    if (os === 'darwin') {
      const uid = execSync('id -u').toString().trim();
      const plist = join(homedir(), 'Library', 'LaunchAgents', 'com.myelin.copilot-headroom.plist');
      try { execSync(`launchctl bootout gui/${uid}/com.myelin.copilot-headroom`, { stdio: 'ignore' }); } catch {}
      execSync('sleep 1');
      execSync(`launchctl bootstrap gui/${uid} ${plist}`, { stdio: 'pipe' });
      log(`  ✓ copilot-headroom restarted (:${port})`);
      return;
    }
    if (os === 'linux') {
      execSync('systemctl --user restart myelin-copilot-headroom.service', { stdio: 'pipe' });
      log(`  ✓ copilot-headroom restarted (:${port})`);
      return;
    }
    if (winManager === 'winsw') {
      const { COPILOT_HEADROOM_SERVICE_ID, restartWinswService } = await import('../service/windows.mjs');
      if (!restartWinswService({ id: COPILOT_HEADROOM_SERVICE_ID })) throw new Error('WinSW restart failed');
      log(`  ✓ copilot-headroom restarted (:${port})`);
      return;
    }
    stopProcessByPort(port, os);
    await new Promise(r => setTimeout(r, 500));
    const regVal = execSync(
      `powershell -Command "(Get-ItemProperty '${REG_RUN}' -Name ${COPILOT_HEADROOM_RUN_KEY} -ErrorAction SilentlyContinue).${COPILOT_HEADROOM_RUN_KEY}"`,
      { stdio: 'pipe' },
    ).toString().trim();
    if (!regVal) throw new Error('registry entry not found — run: myelin install --yes');
    const m = regVal.match(/^"([^"]+)"\s*([\s\S]*)$/) ?? regVal.match(/^(\S+)\s*([\s\S]*)$/);
    if (!m) throw new Error('registry entry malformed');
    const egressPort = cfg?.proxy?.mitm?.egress_port ?? 8889;
    const taskEnv = buildCopilotHeadroomTaskEnv({
      copilotPort: port,
      egressPort,
      mode: cfg?.proxy?.copilot_headroom?.mode ?? 'cache',
    });
    const { spawnDetachedService } = await import('../service/windows.mjs');
    const launch = /start-copilot-headroom\.ps1/i.test(regVal)
      ? { exe: m[1], args: m[2].trim() }
      : persistCopilotHeadroomLauncher({ headroomBin: m[1], argStr: m[2].trim(), taskEnv });
    spawnDetachedService('MyelinCopilotHeadroom', launch.exe, launch.args);
    log(`  ✓ copilot-headroom restarted (:${port})`);
  } catch (e) {
    warn(`  ⚠ copilot-headroom restart failed: ${e.message?.split('\n')[0] ?? e}`);
  }
}

async function defaultRestartMitm({ os, cfg, winManager, log, warn }) {
  try {
    if (os === 'darwin') {
      const uid = execSync('id -u').toString().trim();
      const plist = join(homedir(), 'Library', 'LaunchAgents', 'com.myelin.mitmproxy.plist');
      try { execSync(`launchctl bootout gui/${uid}/com.myelin.mitmproxy`, { stdio: 'ignore' }); } catch {}
      execSync('sleep 1');
      execSync(`launchctl bootstrap gui/${uid} ${plist}`, { stdio: 'pipe' });
      log('  ✓ mitmproxy restarted (launchd)');
      return;
    }
    if (os === 'linux') {
      execSync('systemctl --user restart myelin-mitmproxy.service', { stdio: 'pipe' });
      log('  ✓ mitmproxy restarted (systemd)');
      return;
    }
    if (winManager === 'winsw') {
      const { MITM_SERVICE_ID, restartWinswService } = await import('../service/windows.mjs');
      if (!restartWinswService({ id: MITM_SERVICE_ID })) throw new Error('WinSW restart failed');
      log('  ✓ mitmproxy restarted (WinSW)');
      return;
    }
    stopProcessByPort(cfg?.proxy?.mitm?.port ?? 8888, os);
    if (cfg?.proxy?.copilot_headroom?.enabled) {
      stopProcessByPort(cfg?.proxy?.mitm?.egress_port ?? 8889, os);
    }
    await new Promise(r => setTimeout(r, 500));
    const regVal = execSync(
      `powershell -Command "(Get-ItemProperty '${REG_RUN}' -Name MyelinMitmproxy -ErrorAction SilentlyContinue).MyelinMitmproxy"`,
      { stdio: 'pipe' },
    ).toString().trim();
    if (!regVal) throw new Error('registry entry not found — run: myelin install --yes');
    const m = regVal.match(/^"([^"]+)"\s*([\s\S]*)$/) ?? regVal.match(/^(\S+)\s*([\s\S]*)$/);
    if (!m) throw new Error('registry entry malformed');
    const { spawnDetachedService } = await import('../service/windows.mjs');
    spawnDetachedService('MyelinMitmproxy', m[1], m[2].trim());
    log('  ✓ mitmproxy restarted (hidden)');
  } catch (e) {
    warn(`  ⚠ mitmproxy restart failed: ${e.message?.split('\n')[0] ?? e}`);
  }
}

async function defaultWaitForSelectedEngine({ engine, cfg }) {
  if (engine === 'headroom_lite') return waitForHeadroomLite(cfg?.proxy?.headroom_lite?.port ?? 8790, 5000);
  return waitForHeadroom(cfg?.proxy?.headroom?.port ?? 8787, 20000);
}

export async function runRestart({
  config,
  loadConfigImpl = loadConfig,
  detectOSImpl = detectOS,
  stopObsoleteEngineImpl = stopObsoleteEngine,
  restartHeadroomLiteImpl = (port, os) => restartHeadroomLite(port, os),
  restartManagedHeadroomImpl = defaultRestartManagedHeadroom,
  restartCopilotHeadroomImpl = defaultRestartCopilotHeadroom,
  restartMitmImpl = defaultRestartMitm,
  waitForSelectedEngineImpl = defaultWaitForSelectedEngine,
  log = console.log,
  warn = console.warn,
} = {}) {
  const os = detectOSImpl();
  const cfg = config ?? await loadConfigImpl();
  const engine = selectedEngine(cfg);
  const winManager = cfg?.proxy?.windows_service?.manager ?? 'registry';
  const obsolete = engine === 'headroom' ? 'headroom_lite' : 'headroom';
  log('\n🔄 Restarting Myelin services...');

  const startSelected = async () => {
    if (engine === 'headroom_lite') {
      return restartHeadroomLiteImpl(cfg?.proxy?.headroom_lite?.port ?? 8790, os, cfg);
    }
    await stopObsoleteEngineImpl({ engine: obsolete, os, cfg, winManager });
    await restartManagedHeadroomImpl({ os, cfg, winManager, log, warn });
    return true;
  };

  if (os === 'windows' && winManager !== 'winsw' && cfg?.proxy?.copilot_headroom?.enabled && engine === 'headroom') {
    await restartCopilotHeadroomImpl({ os, cfg, winManager, log, warn });
    const copilotPort = cfg?.proxy?.copilot_headroom?.port ?? 8788;
    const cpHealthy = await waitForHeadroom(copilotPort, 90000);
    if (cpHealthy) {
      log(`  ✓ copilot-headroom healthy on :${copilotPort}`);
    } else {
      log('  ↷ copilot-headroom still starting — proceeding to headroom');
    }
    await startSelected();
  } else {
    const started = await startSelected();
    if (engine === 'headroom_lite') {
      if (!started) {
        warn('  ⚠ headroom-lite did not start; keeping the existing headroom service running');
        log();
        return;
      }
      await stopObsoleteEngineImpl({ engine: obsolete, os, cfg, winManager });
    }
    await restartCopilotHeadroomImpl({ os, cfg, winManager, log, warn });
  }

  await restartMitmImpl({ os, cfg, winManager, log, warn });

  const healthy = await waitForSelectedEngineImpl({ engine, cfg, os });
  if (engine === 'headroom_lite') {
    log(healthy
      ? `  ✓ headroom-lite healthy on :${cfg?.proxy?.headroom_lite?.port ?? 8790}`
      : '  ↷ headroom-lite still starting — run: myelin verify to confirm');
  } else {
    log(healthy
      ? `  ✓ headroom healthy on :${cfg?.proxy?.headroom?.port ?? 8787}`
      : '  ↷ headroom starting in background — run: myelin verify to confirm');
  }
  log();
}
