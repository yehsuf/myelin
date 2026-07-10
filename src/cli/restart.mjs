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
        const intercept = cfg?.proxy?.headroom?.intercept_tool_results !== false;
        const args = ['proxy', '--port', String(port), ...(intercept ? ['--intercept-tool-results'] : [])];
        // In non-interactive sessions (SSH, scripts) Windows User-scope env vars from
        // HKCU\Environment are NOT automatically inherited — headroom needs SSL_CERT_FILE
        // and REQUESTS_CA_BUNDLE to connect through corporate CAs. Load them explicitly.
        const userEnvKeys = ['SSL_CERT_FILE', 'REQUESTS_CA_BUNDLE', 'HEADROOM_CA_BUNDLE',
                             'NODE_EXTRA_CA_CERTS', 'OPENAI_TARGET_URL', 'ANTHROPIC_BASE_URL'];
        const loadEnv = userEnvKeys
          .map(k => `$env:${k} = [Environment]::GetEnvironmentVariable('${k}','User')`)
          .join('; ');
        const argList = args.map(a => `'${a}'`).join(',');
        execSync(
          `powershell -Command "${loadEnv}; Stop-Process -Name headroom -Force -ErrorAction SilentlyContinue; Start-Sleep -Milliseconds 500; Start-Process -FilePath '${bin}' -ArgumentList ${argList} -WindowStyle Hidden"`,
          { stdio: 'pipe' }
        );
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
        execSync('powershell -Command "Stop-Process -Name mitmdump -ErrorAction SilentlyContinue; Start-Sleep -Milliseconds 500"', { stdio: 'pipe' });
        const regVal = execSync(
          `powershell -Command "(Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run' -Name MyelinMitmproxy -ErrorAction SilentlyContinue).MyelinMitmproxy"`,
          { stdio: 'pipe' }
        ).toString().trim();
        if (regVal) {
          execSync(`powershell -Command "Start-Process -FilePath 'powershell.exe' -ArgumentList '-WindowStyle Hidden -ExecutionPolicy Bypass -Command & { ${regVal.replace(/'/g, "''")} }' -WindowStyle Hidden"`, { stdio: 'pipe' });
          console.log('  ✓ mitmproxy restarted (hidden)');
        } else {
          console.warn('  ⚠ mitmproxy registry entry not found — run: node src/install.mjs --yes');
        }
      }
    } catch { console.warn('  ⚠ mitmproxy restart failed'); }
  }

  // Health check
  const port = 8787;
  const healthy = await waitForHeadroom(port, 20000);
  healthy ? console.log(`  ✓ headroom healthy on :${port}`) : console.warn(`  ⚠ headroom not responding on :${port}`);
  console.log();
}
