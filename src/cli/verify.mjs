import { loadConfig } from '../config/reader.mjs';
import { waitForHeadroom, headroomHealthUrl } from '../tools/headroom.mjs';
import { detectTool } from '../detect/tools.mjs';
import { serviceStatus, mitmServiceStatus } from '../service/index.mjs';
import { which } from '../detect/which.mjs';
import { homedir } from 'node:os';
import { join } from 'node:path';

function ensureWindowsPath() {
  if (process.platform !== 'win32') return;
  const home = homedir();
  const extra = [
    join(home, '.local', 'bin'),
    join(home, '.tokenstack', 'bin'),
    join(home, 'AppData', 'Roaming', 'uv', 'bin'),
    join(home, 'AppData', 'Local', 'uv', 'bin'),
    ...[...Array(8)].map((_, i) => join(home, 'AppData', 'Roaming', 'Python', `Python3${10+i}`, 'Scripts')),
    ...[...Array(8)].map((_, i) => join(home, 'AppData', 'Local', 'Programs', 'Python', `Python3${10+i}`, 'Scripts')),
  ];
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

  const mitmSvc = await mitmServiceStatus();
  const mitmdump = await which('mitmdump');
  results.push({
    name: `Mitmproxy service (:${mitmPort})`,
    ok: mitmSvc.running,
    detail: mitmSvc.running
      ? `running${mitmdump ? ` (${mitmdump})` : ''}`
      : mitmdump ? 'not running — try: myelin diagnose' : 'mitmdump not found — run: myelin update',
  });

  for (const tool of ['uv', 'serena', 'ast-grep']) {
    const r = await detectTool(tool, '--version');
    results.push({ name: tool, ok: r.installed, detail: r.installed ? r.version : 'not found — run: myelin update' });
  }
  // semble uses subcommands, not --version
  const { detectSemble } = await import('../detect/tools.mjs');
  const semble = await detectSemble();
  results.push({ name: 'semble', ok: semble.installed, detail: semble.installed ? semble.version : 'not found — run: myelin update' });

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
