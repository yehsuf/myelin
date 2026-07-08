import { execSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
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
      execSync('launchctl unload ~/Library/LaunchAgents/com.myelin.headroom.plist 2>/dev/null; launchctl load ~/Library/LaunchAgents/com.myelin.headroom.plist', { shell: true, stdio: 'pipe' });
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
      execSync('launchctl unload ~/Library/LaunchAgents/com.myelin.mitmproxy.plist 2>/dev/null; launchctl load ~/Library/LaunchAgents/com.myelin.mitmproxy.plist', { shell: true, stdio: 'pipe' });
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
  const healthy = await waitForHeadroom(port, 8000);
  healthy ? console.log(`  ✓ headroom healthy on :${port}`) : console.warn(`  ⚠ headroom not responding on :${port}`);
  console.log();
}
