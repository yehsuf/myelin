import { execSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readdirSync, existsSync } from 'node:fs';
import { detectOS } from '../detect/os.mjs';
import { waitForHeadroom, headroomBinPath } from '../tools/headroom.mjs';
import { loadConfig } from '../config/reader.mjs';

export async function runRestart() {
  const os = detectOS();
  const cfg = os === 'windows' ? await loadConfig() : null;
  const winManager = cfg?.proxy?.windows_service?.manager ?? 'registry';
  console.log('\n🔄 Restarting Myelin services...');

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
      }
    } catch { console.warn('  ⚠ headroom restart failed'); }
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

  // --- copilot-headroom (opt-in dedicated instance) ---
  if (os === 'windows' && cfg?.proxy?.copilot_headroom?.enabled) {
    // Wait for main headroom to be up before starting copilot-headroom
    // to prevent both instances competing for Python/uvicorn startup resources
    await waitForHeadroom(cfg?.proxy?.headroom?.port ?? 8787, 25000);
    try {
      const regKey = 'MyelinCopilotHeadroom';
      const regVal = execSync(
        `powershell -Command "(Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run' -Name ${regKey} -ErrorAction SilentlyContinue).${regKey}"`,
        { stdio: 'pipe' }
      ).toString().trim();
      if (regVal) {
        const m = regVal.match(/^"([^"]+)"\s*([\s\S]*)$/) ?? regVal.match(/^(\S+)\s*([\s\S]*)$/);
        if (m) {
          try { execSync('powershell -Command "Get-Process -Name headroom -ErrorAction SilentlyContinue | Where-Object {$_.MainWindowTitle -eq \'\'} | Stop-Process -Force"', { stdio: 'pipe' }); } catch {}
          const { spawnDetachedService } = await import('../service/windows.mjs');
          const copilotPort = cfg?.proxy?.copilot_headroom?.port ?? 8788;
          const copilotWorkspace = join(homedir(), '.myelin', `headroom-copilot-${copilotPort}`);
          spawnDetachedService('MyelinCopilotHeadroom', m[1], m[2].trim(), {
            taskEnv: { HEADROOM_WORKSPACE_DIR: copilotWorkspace },
          });
          console.log('  ✓ copilot-headroom restarted (:8788)');
        }
      } else {
        console.warn('  ⚠ copilot-headroom registry entry not found — run: myelin install --yes');
      }
    } catch (e) { console.warn(`  ⚠ copilot-headroom restart failed: ${e.message?.split('\n')[0] ?? e}`); }
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
