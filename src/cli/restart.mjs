import { execSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readdirSync } from 'node:fs';
import { detectOS } from '../detect/os.mjs';
import { waitForHeadroom } from '../tools/headroom.mjs';
import { headroomBinPath } from '../tools/headroom.mjs';
import { existsSync } from 'node:fs';

export async function runRestart() {
  const os = detectOS();
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
    // Windows — kill and restart via registry entry
    try {
      execSync('powershell -Command "Stop-Process -Name headroom -ErrorAction SilentlyContinue; Start-Sleep -Milliseconds 500"', { stdio: 'pipe' });
      const bin = headroomBinPath();
      if (existsSync(bin)) {
        execSync(`powershell -Command "Start-Process -FilePath '${bin}' -ArgumentList 'proxy' -WindowStyle Hidden"`, { stdio: 'pipe' });
      }
      console.log('  ✓ headroom restarted');
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
    // Windows — kill and restart via registry Run key entry
    try {
      execSync('powershell -Command "Stop-Process -Name mitmdump -ErrorAction SilentlyContinue; Start-Sleep -Milliseconds 500"', { stdio: 'pipe' });
      // Read the registered command from registry and restart hidden
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
    } catch { console.warn('  ⚠ mitmproxy restart failed'); }
  }

  // Health check
  const port = 8787;
  const healthy = await waitForHeadroom(port, 20000);
  healthy ? console.log(`  ✓ headroom healthy on :${port}`) : console.warn(`  ⚠ headroom not responding on :${port}`);
  console.log();
}
