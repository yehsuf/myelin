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

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function toFiniteNumber(value) {
  return Number.isFinite(value) ? value : null;
}

function formatCount(value) {
  return value === null ? null : new Intl.NumberFormat('en-US').format(value);
}

function formatPercent(value) {
  return `${value.toFixed(1)}%`;
}

function unavailableStatsRows() {
  return { available: false, rows: [['Status', 'unavailable']] };
}

function renderHeadroomLiteStatsRows(payload) {
  if (!isRecord(payload) || payload.service !== 'headroom-lite') {
    return unavailableStatsRows();
  }

  const requestCount = toFiniteNumber(payload.proxy_requests);
  const compressedRequestCount = toFiniteNumber(payload.compress_requests);
  const compressionPct = toFiniteNumber(payload.compress_pct);
  const tokensSaved = toFiniteNumber(payload.compress_tokens_saved);

  if (
    requestCount === null ||
    compressedRequestCount === null ||
    compressionPct === null ||
    tokensSaved === null
  ) {
    return unavailableStatsRows();
  }

  return {
    available: true,
    rows: [
      ['Status', 'running'],
      ['Requests', `${formatCount(requestCount)} total, ${formatCount(compressedRequestCount)} compressed`],
      ['Compression', formatPercent(compressionPct)],
      ['Tokens', `${formatCount(tokensSaved)} saved`],
    ],
  };
}

function renderCopilotHeadroomStatsRows(payload) {
  if (!isRecord(payload)) {
    return unavailableStatsRows();
  }

  const summary = isRecord(payload.summary) ? payload.summary : null;
  const compression = isRecord(summary?.compression) ? summary.compression : null;
  if (!summary || !compression) {
    return unavailableStatsRows();
  }

  const requestCount = toFiniteNumber(summary.api_requests);
  const compressedRequestCount = toFiniteNumber(compression.requests_compressed);
  const tokensBefore = toFiniteNumber(compression.total_tokens_before_with_cli_filtering);
  const tokensSaved = toFiniteNumber(compression.total_tokens_saved_with_cli_filtering);

  if (
    requestCount === null ||
    compressedRequestCount === null ||
    tokensBefore === null ||
    tokensSaved === null ||
    tokensBefore === 0
  ) {
    return unavailableStatsRows();
  }

  const compressionPct = (tokensSaved / tokensBefore) * 100;
  if (!Number.isFinite(compressionPct)) {
    return unavailableStatsRows();
  }

  return {
    available: true,
    rows: [
      ['Status', 'running'],
      ['Requests', `${formatCount(requestCount)} total, ${formatCount(compressedRequestCount)} compressed`],
      ['Compression', formatPercent(compressionPct)],
      ['Tokens', `${formatCount(tokensSaved)} saved`],
    ],
  };
}

export function renderLocalStatsRows(payload) {
  const headroomLite = renderHeadroomLiteStatsRows(payload);
  if (headroomLite.available) return headroomLite;

  return renderCopilotHeadroomStatsRows(payload);
}

function parseMitmLog(logPath) {
  const lines = readFileSync(logPath, 'utf8').split('\n');
  // Request compressed:  ✓ host BEFORE→AFTERB (PCT%)
  const compRe = /^\[(\d{2}:\d{2}:\d{2}\.\d+)\] \[myelin\] ✓ (\S+) (\d+)→(\d+)B \(([\d.]+)%\)/;
  // Tool filter:          tools BEFORE→AFTER
  const toolRe = /\[myelin\] tools (\d+)→(\d+)/;
  // Provider usage:       usage HOST in=N out=N ... cost=$X saved=$X model=M
  const usageRe = /\[myelin\] usage (\S+) in=(\d+) out=(\d+) cache_read=(\d+) cache_write=(\d+) cost=\$([\d.]+) saved=\$([\d.]+)(?:\s+model=(\S+))?/;
  // Error lines
  const errRe = /\[myelin\] .*(unreachable|error|failed)/i;

  let totalBefore = 0, totalAfter = 0, reqCount = 0, pctSum = 0;
  let totalSavedUsd = 0, totalCostUsd = 0, usageCount = 0;
  let totalCacheRead = 0, totalCacheWrite = 0;
  let totalToolsBefore = 0, totalToolsAfter = 0, toolFilterCount = 0;
  let lastTimestamp = '', errorCount = 0;
  const models = new Map();
  const hosts = new Map();

  for (const line of lines) {
    const cm = compRe.exec(line);
    if (cm) {
      const [, ts, host, before, after, pct] = cm;
      totalBefore += parseInt(before); totalAfter += parseInt(after);
      pctSum += parseFloat(pct); reqCount++;
      lastTimestamp = ts;
      hosts.set(host, (hosts.get(host) ?? 0) + 1);
    }
    const tm = toolRe.exec(line);
    if (tm) { totalToolsBefore += parseInt(tm[1]); totalToolsAfter += parseInt(tm[2]); toolFilterCount++; }
    const um = usageRe.exec(line);
    if (um) {
      totalCostUsd += parseFloat(um[6]); totalSavedUsd += parseFloat(um[7]); usageCount++;
      totalCacheRead += parseInt(um[4]); totalCacheWrite += parseInt(um[5]);
      const model = um[8] ?? 'unknown';
      models.set(model, (models.get(model) ?? 0) + 1);
    }
    if (errRe.test(line)) errorCount++;
  }

  const avgPct = reqCount > 0 ? (pctSum / reqCount).toFixed(1) : '0.0';
  const savedMb = ((totalBefore - totalAfter) / 1024 / 1024).toFixed(0);
  const processedGb = (totalBefore / 1024 / 1024 / 1024).toFixed(2);

  return {
    reqCount, avgPct, savedMb, processedGb, lastTimestamp, errorCount,
    totalCostUsd, totalSavedUsd, usageCount, totalCacheRead, totalCacheWrite,
    totalToolsBefore, totalToolsAfter, toolFilterCount,
    topHosts: [...hosts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3),
    topModels: [...models.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3),
  };
}

export async function runStats({ wide = false } = {}) {
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
          console.log('  ⚠  not running — run: myelin restart');
          console.log("     (install: npm i -g @yehsuf/headroom-lite; headroom-lite is myelin's compression sidecar)");
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
          console.log('  ℹ  No requests yet — traffic reaches headroom-lite via mitmproxy sidecar or the _claude wrapper');
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
        row('Status:', 'running');
        row('Requests compressed:', `${d.reqCount}  (processed ${d.processedGb} GB)`);
        row('Avg compression:', `${d.avgPct}%  (${d.savedMb} MB saved)`);
        if (d.toolFilterCount > 0) {
          const toolPct = ((d.totalToolsBefore - d.totalToolsAfter) / d.totalToolsBefore * 100).toFixed(0);
          row('Tool filtering:', `avg ${Math.round(d.totalToolsBefore / d.toolFilterCount)}→${Math.round(d.totalToolsAfter / d.toolFilterCount)} defs/req  (${toolPct}% stripped)`);
        }
        if (d.lastTimestamp) row('Last request:', d.lastTimestamp);
        if (d.usageCount > 0) {
          row('API calls logged:', `${d.usageCount}  (cost $${d.totalCostUsd.toFixed(3)})`);
          if (d.totalCacheRead > 0 || d.totalCacheWrite > 0)
            row('Cache tokens:', `read ${(d.totalCacheRead/1000).toFixed(0)}K  write ${(d.totalCacheWrite/1000).toFixed(0)}K`);
          if (d.topModels.length > 0)
            row('Models seen:', d.topModels.map(([m, n]) => `${m} (${n})`).join(', '));
        }
        if (d.topHosts.length > 0)
          row('Top provider:', d.topHosts.map(([h, n]) => `${h.replace('api.','').replace('.com','')} (${n})`).join(', '));
        if (d.errorCount > 0) console.log(`  ⚠  ${d.errorCount} errors in log`);
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
