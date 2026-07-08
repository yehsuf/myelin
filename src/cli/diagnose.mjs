import { loadConfig } from '../config/reader.mjs';
import { isPortFree, findFreePort } from '../detect/port.mjs';
import { execSync } from 'node:child_process';
import { detectOS } from '../detect/os.mjs';

async function checkPort(port, label, healthCheck, os) {
  const free = await isPortFree(port);
  if (free) {
    console.log(`  ✗ Port ${port} (${label}): not listening — service not running`);
    return;
  }
  const healthy = healthCheck ? await healthCheck().catch(() => false) : null;
  if (healthy === true) {
    console.log(`  ✓ Port ${port} (${label}): healthy`);
    return;
  }
  // Port in use but not ours — find what's using it
  let proc = '';
  try {
    const cmd = os === 'windows'
      ? `powershell -Command "Get-NetTCPConnection -LocalPort ${port} -ErrorAction SilentlyContinue | Select-Object -First 1 | ForEach-Object { (Get-Process -Id $_.OwningProcess -ErrorAction SilentlyContinue).Name }"`
      : `lsof -ti:${port} 2>/dev/null | head -1 | xargs ps -p 2>/dev/null | tail -1 | awk '{print $NF}'`;
    proc = execSync(cmd, { timeout: 3000, stdio: 'pipe' }).toString().trim();
  } catch {}
  if (healthy === false) {
    console.log(`  ✗ Port ${port} (${label}): in use${proc ? ` by ${proc}` : ''} but not responding — orphan process?`);
    try {
      const freePort = await findFreePort(port + 1, port + 20);
      console.log(`    → To fix: myelin restart`);
      console.log(`    → Or use different port: myelin config set proxy.headroom.port ${freePort}`);
    } catch {}
  } else {
    // healthCheck not applicable (mitmproxy) — port in use, process found
    console.log(`  ✓ Port ${port} (${label}): in use by ${proc || 'unknown'}`);
  }
}

export async function runDiagnose() {
  const cfg = await loadConfig();
  const port = cfg.proxy.headroom.port;
  const mitmPort = cfg.proxy?.mitm?.port ?? 8888;
  const os = detectOS();

  console.log(`\nMyelin Diagnostics\n${'─'.repeat(50)}`);

  const { waitForHeadroom } = await import('../tools/headroom.mjs');
  await checkPort(port,     'headroom',  () => waitForHeadroom(port, 2000), os);
  await checkPort(mitmPort, 'mitmproxy', null, os);

  // Process count sanity check
  try {
    const cmd = os === 'windows'
      ? `powershell -Command "(Get-Process headroom -ErrorAction SilentlyContinue | Measure-Object).Count"`
      : `pgrep -x headroom | wc -l`;
    const count = parseInt(execSync(cmd, { timeout: 2000, stdio: 'pipe' }).toString().trim(), 10);
    if (count > 1) console.warn(`  ⚠ ${count} headroom processes — run: myelin restart`);
  } catch {}

  console.log('─'.repeat(50) + '\n');
}
