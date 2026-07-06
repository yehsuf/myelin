import { loadConfig } from '../config/reader.mjs';
import { isPortFree, findFreePort } from '../detect/port.mjs';
import { execSync } from 'node:child_process';
import { detectOS } from '../detect/os.mjs';

export async function runDiagnose() {
  const cfg = await loadConfig();
  const port = cfg.proxy.headroom.port;
  const os = detectOS();

  console.log(`\nMyelin Diagnostics\n${'─'.repeat(50)}`);

  const portFree = await isPortFree(port);
  if (portFree) {
    console.log(`✓ Port ${port}: free (proxy is not running)`);
  } else {
    console.log(`✗ Port ${port}: IN USE`);
    try {
      const cmd = os === 'windows'
        ? `powershell -Command "Get-NetTCPConnection -LocalPort ${port} | Select-Object -First 1 | ForEach-Object { (Get-Process -Id $_.OwningProcess).Name }"`
        : `lsof -ti:${port}`;
      const pid = execSync(cmd, { timeout: 3000 }).toString().trim();
      if (pid) {
        console.log(`  → Process: ${pid}`);
        console.log(`  → To kill orphan: kill ${pid}  (macOS/Linux) or Stop-Process -Id ${pid} (Windows)`);
      }
    } catch {}
    try {
      const freePort = await findFreePort(port + 1, port + 20);
      console.log(`  → Suggested free port: ${freePort}`);
      console.log(`  → To switch: tokenstack config set proxy.headroom.port ${freePort}`);
    } catch {}
  }

  try {
    const cmd = os === 'windows'
      ? `powershell -Command "(Get-Process headroom -ErrorAction SilentlyContinue).Count"`
      : `pgrep -x headroom | wc -l`;
    const count = parseInt(execSync(cmd, { timeout: 2000 }).toString().trim(), 10);
    if (count > 1) console.warn(`⚠ ${count} headroom processes — possible orphan beacons`);
    else if (count === 1) console.log(`✓ Headroom processes: 1 (healthy)`);
    else console.log(`  Headroom: not running`);
  } catch {}

  console.log('─'.repeat(50) + '\n');
}
