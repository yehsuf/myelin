import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { execSync } from 'node:child_process';
import { loadConfig } from '../config/reader.mjs';

const SEP = '─'.repeat(60);

function probe(url, timeoutMs = 2000) {
  try {
    return JSON.parse(
      execSync(`curl -sf --max-time 2 ${url}`, { timeout: timeoutMs + 500 }).toString()
    );
  } catch { return null; }
}

// TCP-level alive check — succeeds even if the service returns non-200 or non-JSON
function isAlive(host, port, timeoutMs = 2000) {
  try {
    execSync(`curl -s --max-time 2 -o /dev/null http://${host}:${port}/`, { timeout: timeoutMs + 500 });
    return true;
  } catch (e) {
    // exit 7 = connection refused, others = some response (alive)
    return e.status !== 7 && e.status !== undefined;
  }
}

function row(label, value) {
  console.log(`  ${label.padEnd(22)}${value}`);
}

function parseMitmLog(logPath) {
  const lines = readFileSync(logPath, 'utf8').split('\n');
  const compRe = /\[myelin\] ✓ (\S+) (\d+)→(\d+)B \(([\d.]+)%\)(?: tokens (\d+)→(\d+))?/;
  const toolRe = /\[myelin\] tools (\d+)→(\d+)/;
  const usageRe = /\[myelin\] usage \S+ in=(\d+) out=(\d+) cache_read=(\d+) cache_write=(\d+) cost=\$([\d.]+) saved=\$([\d.]+)/;
  let totalBefore = 0, totalAfter = 0, reqCount = 0;
  let totalTokBefore = 0, totalTokAfter = 0, tokCount = 0;
  let totalSavedUsd = 0, usageCount = 0;
  let totalToolsBefore = 0, totalToolsAfter = 0, toolFilterCount = 0;
  for (const line of lines) {
    const cm = compRe.exec(line);
    if (cm) {
      const [,, before, after,, tb, ta] = cm;
      totalBefore += parseInt(before); totalAfter += parseInt(after); reqCount++;
      if (tb) { totalTokBefore += parseInt(tb); totalTokAfter += parseInt(ta); tokCount++; }
    }
    const tm = toolRe.exec(line);
    if (tm) { totalToolsBefore += parseInt(tm[1]); totalToolsAfter += parseInt(tm[2]); toolFilterCount++; }
    const um = usageRe.exec(line);
    if (um) { totalSavedUsd += parseFloat(um[6]); usageCount++; }
  }
  return { reqCount, totalBefore, totalAfter, totalTokBefore, totalTokAfter, tokCount, totalSavedUsd, usageCount, totalToolsBefore, totalToolsAfter, toolFilterCount };
}

export async function runStats() {
  const home = homedir();
  const cfg = await loadConfig();
  const sections = [];

  // ── headroom-lite (always check — it's the replacement for headroom) ────────
  const hlPort = cfg?.proxy?.headroom_lite?.port ?? 8790;
  if (cfg?.proxy?.headroom_lite?.enabled !== false) {
    const hlStats = probe(`http://127.0.0.1:${hlPort}/stats`);
    sections.push({
      title: `headroom-lite  (:${hlPort})`,
      print() {
        if (!hlStats || hlStats.service !== 'headroom-lite') {
          console.log('  ⚠  not running — run: headroom-lite');
          console.log('     or: ANTHROPIC_BASE_URL=http://127.0.0.1:8790 node src/index.mjs');
          return;
        }
        const uptime = hlStats.uptime_seconds ?? 0;
        const uptimeStr = uptime < 60 ? `${uptime}s` : uptime < 3600
          ? `${Math.floor(uptime / 60)}m` : `${Math.floor(uptime / 3600)}h ${Math.floor((uptime % 3600) / 60)}m`;
        row('Status:', `running  (up ${uptimeStr})`);
        row('Proxy requests:', String(hlStats.proxy_requests ?? 0));
        row('Compress calls:', String(hlStats.compress_requests ?? 0));
        row('Token compression:', `${hlStats.compress_pct ?? '0.0'}%  (${((hlStats.compress_tokens_saved ?? 0) / 1000).toFixed(0)}K tokens saved)`);
        if ((hlStats.compress_requests ?? 0) === 0)
          console.log('  ℹ  No requests yet — set ANTHROPIC_BASE_URL=http://127.0.0.1:8790');
      },
    });
  }

  // ── mitmproxy (if enabled in config) ───────────────────────────────────────
  const mitmEnabled = cfg?.proxy?.mitm?.enabled ?? false;
  const mitmPort = cfg?.proxy?.mitm?.port ?? 8888;
  if (mitmEnabled) {
    const mitmAlive = isAlive('127.0.0.1', mitmPort);
    const logPath = join(home, '.myelin', 'mitmproxy.log');
    sections.push({
      title: `mitmproxy  (:${mitmPort})  — Copilot CLI`,
      print() {
        if (!mitmAlive) {
          console.log('  ⚠  not running — run: myelin restart');
          return;
        }
        if (!existsSync(logPath)) {
          console.log('  running  (no log data yet — start a Copilot session)');
          return;
        }
        const d = parseMitmLog(logPath);
        if (d.reqCount === 0) { console.log('  running  (no compressed requests yet)'); return; }
        const savedBytes = d.totalBefore - d.totalAfter;
        const pct = (savedBytes / d.totalBefore * 100).toFixed(1);
        row('Status:', 'running');
        row('Requests compressed:', String(d.reqCount));
        row('Bytes saved:', `${(savedBytes / 1024).toFixed(0)} KB  (${pct}%)`);
        if (d.tokCount > 0) {
          const tokSaved = d.totalTokBefore - d.totalTokAfter;
          const tokPct = d.totalTokBefore > 0 ? (tokSaved / d.totalTokBefore * 100).toFixed(1) : '0.0';
          row('Token compression:', `${(d.totalTokBefore / 1000).toFixed(0)}K → ${(d.totalTokAfter / 1000).toFixed(0)}K  (${tokPct}%)`);
        }
        if (d.usageCount > 0) row('Cost saved:', `$${d.totalSavedUsd.toFixed(4)}`);
        if (d.toolFilterCount > 0) {
          const toolPct = ((d.totalToolsBefore - d.totalToolsAfter) / d.totalToolsBefore * 100).toFixed(0);
          row('Tools filtered:', `avg ${Math.round(d.totalToolsBefore / d.toolFilterCount)}→${Math.round(d.totalToolsAfter / d.toolFilterCount)} per req (${toolPct}%)`);
        }
      },
    });
  }

  // ── copilot-headroom (if enabled in config) ────────────────────────────────
  const copilotHrEnabled = cfg?.proxy?.copilot_headroom?.enabled ?? false;
  const copilotHrPort = cfg?.proxy?.copilot_headroom?.port ?? 8788;
  if (copilotHrEnabled) {
    const chStats = probe(`http://127.0.0.1:${copilotHrPort}/stats`);
    sections.push({
      title: `copilot-headroom  (:${copilotHrPort})`,
      print() {
        if (!chStats) {
          console.log('  ⚠  not running — run: myelin restart');
          return;
        }
        const s = chStats.summary ?? {};
        const c = s.compression ?? {};
        const bd = s.cost?.breakdown ?? {};
        const tokBefore = c.total_tokens_before_with_cli_filtering ?? 0;
        const tokSaved = c.total_tokens_saved_with_cli_filtering ?? 0;
        const pct = tokBefore > 0 ? (tokSaved / tokBefore * 100).toFixed(1) : '0.0';
        const totalSaved = (bd.cache_savings_usd ?? 0) + (bd.compression_savings_usd ?? 0);
        row('Status:', 'running');
        row('Requests:', `${s.api_requests ?? 0} total, ${c.requests_compressed ?? 0} compressed`);
        row('Token compression:', `${pct}%  (${(tokSaved / 1000).toFixed(0)}K tokens saved)`);
        row('Cost saved:', `$${totalSaved.toFixed(2)}  (cache $${(bd.cache_savings_usd ?? 0).toFixed(2)} + compression $${(bd.compression_savings_usd ?? 0).toFixed(2)})`);
      },
    });
  }

  // ── Render ─────────────────────────────────────────────────────────────────
  console.log('\nMyelin Compression Statistics');
  if (sections.length === 0) {
    console.log(SEP);
    console.log('  No services configured. Run: myelin install --yes');
  } else {
    for (const s of sections) {
      console.log(SEP);
      console.log(`  ${s.title}`);
      s.print();
    }
  }
  console.log(SEP + '\n');
}
