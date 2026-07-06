import { loadConfig } from '../config/reader.mjs';
import { waitForHeadroom, headroomHealthUrl } from '../tools/headroom.mjs';
import { detectTool } from '../detect/tools.mjs';
import { serviceStatus } from '../service/index.mjs';

export async function runVerify() {
  const cfg = await loadConfig();
  const port = cfg.proxy.headroom.port;
  const results = [];

  const svc = await serviceStatus();
  results.push({ name: 'Headroom service', ok: svc.running, detail: svc.running ? 'running' : 'not running — try: tokenstack diagnose' });

  const healthy = await waitForHeadroom(port, 3000);
  results.push({ name: `Headroom health (port ${port})`, ok: healthy, detail: healthy ? headroomHealthUrl(port) : `no response on :${port}` });

  for (const tool of ['uv', 'serena', 'semble', 'ast-grep']) {
    const r = await detectTool(tool, '--version');
    results.push({ name: tool, ok: r.installed, detail: r.installed ? r.version : 'not found — run: tokenstack update' });
  }

  const width = Math.max(...results.map(r => r.name.length));
  console.log('\nTokenStack Component Status\n' + '─'.repeat(60));
  for (const r of results) {
    console.log(`  ${r.ok ? '✓' : '✗'} ${r.name.padEnd(width + 2)} ${r.detail}`);
  }
  console.log('─'.repeat(60));
  const passed = results.filter(r => r.ok).length;
  console.log(`  ${passed}/${results.length} components healthy\n`);
  return results.every(r => r.ok);
}
