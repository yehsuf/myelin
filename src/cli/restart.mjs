import { execSync, spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync, readdirSync, existsSync, writeFileSync } from 'node:fs';
import { detectOS } from '../detect/os.mjs';
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
async function restartHeadroomLite(port, osKind) {
  // Best-effort probe: is the binary available? Using shell so npm shims work.
  const probeCmd = osKind === 'windows'
    ? `powershell -Command "if (Get-Command headroom-lite -ErrorAction SilentlyContinue) { exit 0 } else { exit 1 }"`
    : `command -v headroom-lite >/dev/null 2>&1`;
  try {
    execSync(probeCmd, { stdio: 'pipe' });
  } catch {
    console.log('  ↷ headroom-lite not installed — run: npm i -g @yehsuf/headroom-lite');
    return;
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
    return;
  }

  // Quick health probe — headroom-lite is a small Node.js server, usually up
  // in <1s. Don't block for long.
  const healthy = await waitForHeadroomLite(port, 5000);
  if (healthy) {
    console.log(`  ✓ headroom-lite healthy on :${port}`);
  } else {
    console.log(`  ↷ headroom-lite still starting — run: myelin verify to confirm`);
  }
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

export async function runRestart() {
  const os = detectOS();
  const cfg = await loadConfig();
  const winManager = cfg?.proxy?.windows_service?.manager ?? 'registry';
  console.log('\n🔄 Restarting Myelin services...');

  // headroom-lite (multi-provider sidecar) — restart first so subsequent
  // services find it healthy. Skipped when explicitly disabled via config.
  if (cfg?.proxy?.headroom_lite?.enabled !== false) {
    const hlPort = cfg?.proxy?.headroom_lite?.port ?? 8790;
    await restartHeadroomLite(hlPort, os);
  }

  // On Windows with copilot_headroom enabled, reverse the startup order:
  // start copilot-headroom FIRST (lighter --mode cache), wait for it to be
  // healthy, then start main headroom. This prevents Windows Defender / Python
  // .pyc cache from serializing the two identical import chains simultaneously,
  // which causes one instance to block for 60+ seconds.
  if (os === 'windows' && winManager !== 'winsw' && cfg?.proxy?.copilot_headroom?.enabled) {
    // Kill all headroom processes upfront
    try {
      execSync('powershell -Command "Stop-Process -Name headroom -Force -ErrorAction SilentlyContinue"', { stdio: 'pipe' });
      await new Promise(r => setTimeout(r, 800));
    } catch {}

    // 1. copilot-headroom:8788 FIRST
    const copilotPort = cfg?.proxy?.copilot_headroom?.port ?? 8788;
    const egressPort = cfg?.proxy?.mitm?.egress_port ?? 8889;
    const copilotTaskEnv = buildCopilotHeadroomTaskEnv({
      copilotPort,
      egressPort,
      mode: cfg?.proxy?.copilot_headroom?.mode ?? 'cache',
    });
    try {
      const regVal = execSync(
        `powershell -Command "(Get-ItemProperty '${REG_RUN}' -Name ${COPILOT_HEADROOM_RUN_KEY} -ErrorAction SilentlyContinue).${COPILOT_HEADROOM_RUN_KEY}"`,
        { stdio: 'pipe' }
      ).toString().trim();
      if (regVal) {
        const m = regVal.match(/^"([^"]+)"\s*([\s\S]*)$/) ?? regVal.match(/^(\S+)\s*([\s\S]*)$/);
        if (m) {
          const { spawnDetachedService } = await import('../service/windows.mjs');
          const launch = /start-copilot-headroom\.ps1/i.test(regVal)
            ? { exe: m[1], args: m[2].trim() }
            : persistCopilotHeadroomLauncher({ headroomBin: m[1], argStr: m[2].trim(), taskEnv: copilotTaskEnv });
          spawnDetachedService('MyelinCopilotHeadroom', launch.exe, launch.args);
          console.log('  ✓ copilot-headroom started (:8788)');
        }
      }
    } catch (e) { console.warn(`  ⚠ copilot-headroom start failed: ${e.message?.split('\n')[0] ?? e}`); }

    // Wait for copilot-headroom to be healthy before starting main headroom.
    // Once copilot-headroom is up, Python .pyc cache + Windows Defender scan
    // cache are warm — main headroom starts in ~5s instead of 60s+.
    const cpHealthy = await waitForHeadroom(copilotPort, 90000);
    if (cpHealthy) {
      console.log(`  ✓ copilot-headroom healthy on :${copilotPort}`);
    } else {
      console.log(`  ↷ copilot-headroom still starting — proceeding to main headroom`);
    }

    // 2. main headroom:8787 (caches warm now)
    try {
      const bin = headroomBinPath();
      const port = cfg?.proxy?.headroom?.port ?? 8787;
      const argStr = `proxy --port ${port}`;
      const { spawnDetachedService } = await import('../service/windows.mjs');
      spawnDetachedService('MyelinHeadroom', bin, argStr);
      console.log('  ✓ headroom restarted');
    } catch (e) { console.warn(`  ⚠ headroom restart failed: ${e.message?.split('\n')[0] ?? e}`); }

    // 3. mitmproxy (independent of headroom Python caches)
    try {
      try {
        execSync('powershell -Command "Get-Process -Name mitmdump -ErrorAction SilentlyContinue | Stop-Process -Force"', { stdio: 'pipe' });
      } catch {}
      await new Promise(r => setTimeout(r, 500));
      const regVal = execSync(
        `powershell -Command "(Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run' -Name MyelinMitmproxy -ErrorAction SilentlyContinue).MyelinMitmproxy"`,
        { stdio: 'pipe' }
      ).toString().trim();
      if (regVal) {
        const m = regVal.match(/^"([^"]+)"\s*([\s\S]*)$/) ?? regVal.match(/^(\S+)\s*([\s\S]*)$/);
        if (m) {
          const { spawnDetachedService } = await import('../service/windows.mjs');
          spawnDetachedService('MyelinMitmproxy', m[1], m[2].trim());
          console.log('  ✓ mitmproxy restarted (hidden)');
        }
      } else {
        console.warn('  ⚠ mitmproxy registry entry not found — run: myelin install --yes');
      }
    } catch (e) { console.warn(`  ⚠ mitmproxy restart failed: ${e.message?.split('\n')[0] ?? e}`); }

    // Quick health probe for main headroom
    const healthy = await waitForHeadroom(cfg?.proxy?.headroom?.port ?? 8787, 20000);
    healthy
      ? console.log(`  ✓ headroom healthy on :${cfg?.proxy?.headroom?.port ?? 8787}`)
      : console.log(`  ↷ headroom starting in background — run: myelin verify to confirm`);
    console.log();
    return;
  }

  // --- headroom ---
  if (os === 'darwin') {
    try {
      const uid = execSync('id -u').toString().trim();
      const la = join(homedir(), 'Library', 'LaunchAgents');
      // Accept any headroom plist — prefer com.myelin.headroom, fall back to any match
      const allHeadroom = readdirSync(la).filter(f => f.endsWith('.headroom.plist') && !f.includes('.bak'));
      const canonical = allHeadroom.find(f => f === 'com.myelin.headroom.plist') ?? allHeadroom[0];
      if (!canonical) throw new Error('no headroom plist found');
      // Bootout all variants first
      for (const pf of allHeadroom) {
        try { execSync(`launchctl bootout gui/${uid}/${pf.replace('.plist', '')}`, { stdio: 'ignore' }); } catch {}
      }
      execSync('sleep 1');
      execSync(`launchctl bootstrap gui/${uid} ${join(la, canonical)}`, { stdio: 'pipe' });
      console.log('  ✓ headroom restarted (launchd)');
    } catch { console.warn('  ⚠ headroom launchd restart failed — trying direct'); }
  } else if (os === 'linux') {
    try {
      execSync('systemctl --user restart myelin-headroom.service', { stdio: 'pipe' });
      console.log('  ✓ headroom restarted (systemd)');
    } catch { console.warn('  ⚠ systemd restart failed'); }
  } else {
    // Windows — WinSW when opted in (manager: 'winsw'), else the original
    // kill-and-restart-via-registry mechanism (default, unchanged behavior).
    try {
      if (winManager === 'winsw') {
        const { HEADROOM_SERVICE_ID, restartWinswService } = await import('../service/windows.mjs');
        if (!restartWinswService({ id: HEADROOM_SERVICE_ID })) throw new Error('WinSW restart failed');
        console.log('  ✓ headroom restarted (WinSW)');
      } else {
        const bin = headroomBinPath();
        const port = cfg?.proxy?.headroom?.port ?? 8787;
        // No --intercept-tool-results CLI flag — use HEADROOM_INTERCEPT_ENABLED=1 env var instead
        // (the flag calls ensure_tools() which blocks in restricted-network Task Scheduler sessions)
        const argStr = `proxy --port ${port}`;
        execSync('powershell -Command "Stop-Process -Name headroom -Force -ErrorAction SilentlyContinue"', { stdio: 'pipe' });
        await new Promise(r => setTimeout(r, 500));
        const { spawnDetachedService } = await import('../service/windows.mjs');
        spawnDetachedService('MyelinHeadroom', bin, argStr);
        console.log('  ✓ headroom restarted');
        // Wait for headroom to be healthy before starting mitmproxy —
        // concurrent Python startup causes resource contention and delays.
        if (!await waitForHeadroom(port, 20000)) {
          console.log('  ↷ headroom still starting — mitmproxy will follow');
        }
      }
    } catch (e) { console.warn(`  ⚠ headroom restart failed: ${e.message?.split('\n')[0] ?? e}`); }
  }

  // --- mitmproxy ---
  if (os === 'darwin') {
    try {
      const uid = execSync('id -u').toString().trim();
      const mp = `${homedir()}/Library/LaunchAgents/com.myelin.mitmproxy.plist`;
      try { execSync(`launchctl bootout gui/${uid}/com.myelin.mitmproxy`, { stdio: 'ignore' }); } catch {}
      execSync('sleep 1');
      execSync(`launchctl bootstrap gui/${uid} ${mp}`, { stdio: 'pipe' });
      console.log('  ✓ mitmproxy restarted (launchd)');
    } catch { console.warn('  ⚠ mitmproxy launchd restart failed'); }
  } else if (os === 'linux') {
    try {
      execSync('systemctl --user restart myelin-mitmproxy.service', { stdio: 'pipe' });
      console.log('  ✓ mitmproxy restarted (systemd)');
    } catch { console.warn('  ⚠ systemd restart failed'); }
  } else {
    // Windows — WinSW when opted in, else the original registry-Run-key
    // read-and-restart mechanism (default, unchanged behavior).
    try {
      if (winManager === 'winsw') {
        const { MITM_SERVICE_ID, restartWinswService } = await import('../service/windows.mjs');
        if (!restartWinswService({ id: MITM_SERVICE_ID })) throw new Error('WinSW restart failed');
        console.log('  ✓ mitmproxy restarted (WinSW)');
      } else {
        // Stop is best-effort — it may fail if the process is not running or
        // is locked by another job object (SSH context). Never let it abort restart.
        try {
          execSync('powershell -Command "Get-Process -Name mitmdump -ErrorAction SilentlyContinue | Stop-Process -Force"', { stdio: 'pipe' });
        } catch {}
        await new Promise(r => setTimeout(r, 500));
        const regVal = execSync(
          `powershell -Command "(Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run' -Name MyelinMitmproxy -ErrorAction SilentlyContinue).MyelinMitmproxy"`,
          { stdio: 'pipe' }
        ).toString().trim();
        if (regVal) {
          // Parse "exe" args or exe args from the registry value
          const m = regVal.match(/^"([^"]+)"\s*([\s\S]*)$/) ?? regVal.match(/^(\S+)\s*([\s\S]*)$/);
          if (m) {
            const { spawnDetachedService } = await import('../service/windows.mjs');
            spawnDetachedService('MyelinMitmproxy', m[1], m[2].trim());
            console.log('  ✓ mitmproxy restarted (hidden)');
          }
        } else {
          console.warn('  ⚠ mitmproxy registry entry not found — run: myelin install --yes');
        }
      }
    } catch (e) { console.warn(`  ⚠ mitmproxy restart failed: ${e.message?.split('\n')[0] ?? e}`); }
  }

  // Health check — headroom can take 30-90s to start via Task Scheduler on first run
  // (Python module compilation). Don't block — show tip to run `myelin verify`.
  const port = 8787;
  const healthy = await waitForHeadroom(port, 8000);   // quick probe only
  if (healthy) {
    console.log(`  ✓ headroom healthy on :${port}`);
  } else {
    console.log(`  ↷ headroom starting in background — run: myelin verify to confirm`);
  }
  console.log();
}
