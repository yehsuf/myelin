import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { execSync } from 'node:child_process';
import { loadConfig } from '../config/reader.mjs';

export async function runStats() {
  const home = homedir();
  const cfg = await loadConfig();
  const copilotHrEnabled = cfg?.proxy?.copilot_headroom?.enabled ?? false;
  const copilotHrPort   = cfg?.proxy?.copilot_headroom?.port ?? 8788;
  const logPath = join(home, '.myelin', 'mitmproxy.log');

  console.log('\nMyelin Compression Statistics\n' + '─'.repeat(60));

  // --- Copilot stats ---
  console.log('  Copilot CLI (via mitmproxy :8888)');

  if (copilotHrEnabled) {
    // Full pipeline: mitmproxy redirects to copilot-headroom → official /stats
    try {
      const statsUrl = `http://127.0.0.1:${copilotHrPort}/stats`;
      const resp = JSON.parse(execSync(`curl -sf ${statsUrl}`, { timeout: 3000 }).toString());
      const s = resp.summary ?? {};
      const c = s.compression ?? {};
      const cost = s.cost ?? {};
      const bd = cost.breakdown ?? {};
      const reqs = s.api_requests ?? 0;
      const compressed = c.requests_compressed ?? 0;
      const tokBefore = c.total_tokens_before_with_cli_filtering ?? 0;
      const tokSaved  = c.total_tokens_saved_with_cli_filtering ?? 0;
      const comprPct  = tokBefore > 0 ? (tokSaved / tokBefore * 100).toFixed(1) : '0.0';
      const cacheSavedUsd = bd.cache_savings_usd ?? 0;
      const comprSavedUsd = bd.compression_savings_usd ?? 0;
      const totalSavedUsd = cacheSavedUsd + comprSavedUsd;
      console.log(`  Requests:             ${reqs} total, ${compressed} compressed`);
      console.log(`  Text compression:     ${comprPct}%  (${(tokSaved/1000).toFixed(0)}K tokens saved)`);
      console.log(`  Cost saved:           $${totalSavedUsd.toFixed(2)}  (cache $${cacheSavedUsd.toFixed(2)} + compression $${comprSavedUsd.toFixed(2)})`);
      // Also try headroom perf for cache hit rate
      try {
        const perf = execSync(`"${headroomBin()}" perf --port ${copilotHrPort}`, { timeout: 5000, env: { ...process.env, PYTHONWARNINGS: 'ignore', LITELLM_LOG: 'ERROR' } }).toString();
        const hitMatch = perf.match(/Hit rate:\s+([\d.]+%)/);
        if (hitMatch) console.log(`  KV cache hit rate:    ${hitMatch[1]}`);
      } catch { /* not all headroom versions support --port flag */ }
      if (reqs === 0) console.log('  ℹ  No requests yet — run _copilot to start a session');
    } catch {
      console.log(`  ⚠  copilot-headroom (:${copilotHrPort}) unavailable — run: myelin restart`);
    }
  } else if (existsSync(logPath)) {
    // Fallback: parse mitmproxy log file (only populated on Mac/Linux with launchd logging)
    const lines = readFileSync(logPath, 'utf8').split('\n');
    const compRe = /\[myelin\] ✓ (\S+) (\d+)→(\d+)B \(([\d.]+)%\)(?: tokens (\d+)→(\d+))?/;
    const toolRe = /\[myelin\] tools (\d+)→(\d+)/;
    const usageRe = /\[myelin\] usage \S+ in=(\d+) out=(\d+) cache_read=(\d+) cache_write=(\d+) cost=\$([\d.]+) saved=\$([\d.]+)/;
    let totalBefore = 0, totalAfter = 0, reqCount = 0;
    let totalTokBefore = 0, totalTokAfter = 0, tokCount = 0;
    let totalIn = 0, totalOut = 0, totalCacheRead = 0, totalCacheWrite = 0, usageCount = 0;
    let totalCostUsd = 0, totalSavedUsd = 0;
    let totalToolsBefore = 0, totalToolsAfter = 0, toolFilterCount = 0;
    const byHost = {};
    for (const line of lines) {
      const cm = compRe.exec(line);
      if (cm) {
        const [, host, before, after, , tb, ta] = cm;
        const b = parseInt(before), a = parseInt(after);
        totalBefore += b; totalAfter += a; reqCount++;
        if (tb) { totalTokBefore += parseInt(tb); totalTokAfter += parseInt(ta); tokCount++; }
        byHost[host] = byHost[host] ?? { before: 0, after: 0, count: 0 };
        byHost[host].before += b; byHost[host].after += a; byHost[host].count++;
      }
      const tm = toolRe.exec(line); if (tm) { totalToolsBefore += parseInt(tm[1]); totalToolsAfter += parseInt(tm[2]); toolFilterCount++; }
      const um = usageRe.exec(line); if (um) { totalIn += parseInt(um[1]); totalOut += parseInt(um[2]); totalCacheRead += parseInt(um[3]); totalCacheWrite += parseInt(um[4]); totalCostUsd += parseFloat(um[5]); totalSavedUsd += parseFloat(um[6]); usageCount++; }
    }
    if (reqCount === 0) {
      console.log('  No compressed requests yet. Run _copilot first.\n');
    } else {
      const savedBytes = totalBefore - totalAfter;
      const pct = (savedBytes / totalBefore * 100).toFixed(1);
      console.log(`  Requests compressed:  ${reqCount}`);
      console.log(`  Bytes saved:          ${(savedBytes/1024).toFixed(0)} KB  (${pct}%)`);
      if (tokCount > 0) { const tokSaved = totalTokBefore - totalTokAfter; const tokPct = (tokSaved / totalTokBefore * 100).toFixed(1); console.log(`  Token compression:    ${(totalTokBefore/1000).toFixed(0)}K → ${(totalTokAfter/1000).toFixed(0)}K  (${tokPct}%)`); }
      if (usageCount > 0) console.log(`  Cost saved:           $${totalSavedUsd.toFixed(4)}`);
      if (toolFilterCount > 0) { const toolPct = ((totalToolsBefore - totalToolsAfter) / totalToolsBefore * 100).toFixed(0); console.log(`  Tools filtered:       avg ${Math.round(totalToolsBefore/toolFilterCount)}→${Math.round(totalToolsAfter/toolFilterCount)} per req (${toolPct}%)`); }
    }
  } else {
    console.log('  ℹ  Enable copilot_headroom for full stats:');
    console.log('     myelin config set proxy.copilot_headroom.enabled true');
    console.log('     myelin install --yes');
  }

  // --- headroom-lite stats (Copilot / Claude Code sidecar) ---
  console.log('\n' + '─'.repeat(60));
  console.log('  Copilot / Claude Code (via headroom-lite :8790)');
  try {
    const resp = JSON.parse(execSync('curl -sf http://127.0.0.1:8790/stats', { timeout: 3000 }).toString());
    const saved = resp.compress_tokens_saved ?? 0;
    const before = resp.compress_tokens_before ?? 0;
    const pct = resp.compress_pct ?? '0.0';
    const proxyReqs = resp.proxy_requests ?? 0;
    const compReqs = resp.compress_requests ?? 0;
    const uptime = resp.uptime_seconds ?? 0;
    const uptimeStr = uptime < 60 ? `${uptime}s` : uptime < 3600 ? `${Math.floor(uptime/60)}m` : `${Math.floor(uptime/3600)}h ${Math.floor((uptime%3600)/60)}m`;
    console.log(`  Uptime:               ${uptimeStr}`);
    console.log(`  Proxy requests:       ${proxyReqs}`);
    console.log(`  Compress calls:       ${compReqs}`);
    console.log(`  Token compression:    ${pct}%  (${(saved/1000).toFixed(0)}K tokens saved)`);
    if (before === 0 && compReqs === 0) {
      console.log('  ℹ  No requests yet — set ANTHROPIC_BASE_URL=http://127.0.0.1:8790');
    }
  } catch {
    console.log('  headroom-lite unavailable on :8790 — run: headroom-lite');
    console.log('  or: ANTHROPIC_BASE_URL=http://127.0.0.1:8790 node src/index.mjs');
  }

  console.log('─'.repeat(60) + '\n');
}
