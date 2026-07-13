import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { execSync } from 'node:child_process';
import { loadConfig } from '../config/reader.mjs';
import { buildEngineInstancePlan } from '../config/engine-runtime.mjs';

const SEP = '─'.repeat(60);
const WIDE_DISCOVERY_HINT = 'More detail: myelin stats --wide';

function probe(url, timeoutMs = 2000) {
  try {
    return JSON.parse(
      execSync(`curl -sf --max-time 2 ${url}`, { timeout: timeoutMs + 500 }).toString()
    );
  } catch { return null; }
}

function isHealthy(url, timeoutMs = 2000) {
  try {
    execSync(`curl -sf --max-time 2 -o /dev/null ${url}`, { timeout: timeoutMs + 500 });
    return true;
  } catch { return false; }
}

export function isAliveRoot(host, port, timeoutMs = 2000, exec = execSync) {
  try {
    exec(`curl -s --max-time 2 -o /dev/null http://${host}:${port}/`, { timeout: timeoutMs + 500 });
    return true;
  } catch (e) {
    return e.status !== 7 && e.status !== undefined;
  }
}

function row(log, label, value) {
  log(`  ${label.padEnd(22)}${value}`);
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
  if (isRecord(payload) && payload.service === 'headroom-lite') {
    return renderHeadroomLiteStatsRows(payload);
  }

  return renderCopilotHeadroomStatsRows(payload);
}

function getConfiguredLocalStatsDescriptors(config) {
  return buildEngineInstancePlan(config).instances.map((instance) => {
    const label = instance.role === 'copilot' ? 'copilot-headroom' : instance.engine.replace('_', '-');
    return {
      label,
      port: instance.port,
      title: `${label}  (:${instance.port})`,
      healthUrl: instance.healthUrl,
      url: `http://127.0.0.1:${instance.port}/stats`,
      formatter: renderLocalStatsRows,
    };
  });
}

export function getWideStatsHint(config) {
  return getConfiguredLocalStatsDescriptors(config).length > 0 ? WIDE_DISCOVERY_HINT : null;
}

export async function collectWideLocalStatsSections({
  config,
  wide = false,
  fetchStats = probe,
} = {}) {
  if (!wide) return [];

  return Promise.all(
    getConfiguredLocalStatsDescriptors(config).map(async (descriptor) => {
      let payload = null;
      try {
        payload = await fetchStats(descriptor.url);
      } catch {
        payload = null;
      }

      const rendered = descriptor.formatter(payload);
      return {
        label: descriptor.label,
        title: descriptor.title,
        available: rendered.available,
        rows: rendered.rows,
      };
    })
  );
}

function parseMitmLog(logPath, readFile = readFileSync) {
  const lines = readFile(logPath, 'utf8').split('\n');
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

function buildLocalStatusSections(config, probeHealth) {
  return getConfiguredLocalStatsDescriptors(config).map((descriptor) => ({
    label: descriptor.label,
    title: descriptor.title,
    print(log) {
      if (!probeHealth(descriptor.healthUrl, descriptor.label)) {
        log('  ⚠  not running — run: myelin restart');
        return;
      }
      log('  running');
    },
  }));
}

function buildWideLocalStatsPrintSections(sections) {
  return sections.map((section) => ({
    label: section.label,
    title: section.title,
    print(log) {
      for (const [label, value] of section.rows) {
        row(log, `${label}:`, value);
      }
    },
  }));
}

export async function runStats({ wide = false } = {}, {
  loadConfig: loadConfigFn = loadConfig,
  log = console.log,
  probeHealth = (url) => isHealthy(url),
  probeRoot = (port) => isAliveRoot('127.0.0.1', port),
  readStats = probe,
  pathExists = existsSync,
  readFile = readFileSync,
  homeDir = homedir(),
} = {}) {
  const cfg = await loadConfigFn();
  const sections = [];

  const localSections = wide
    ? buildWideLocalStatsPrintSections(await collectWideLocalStatsSections({
      config: cfg,
      wide,
      fetchStats: readStats,
    }))
    : buildLocalStatusSections(cfg, probeHealth);
  const headroomLiteSection = localSections.find((section) => section.label === 'headroom-lite');
  const copilotHeadroomSection = localSections.find((section) => section.label === 'copilot-headroom');

  if (headroomLiteSection) sections.push(headroomLiteSection);

  // ── mitmproxy (if enabled in config) ───────────────────────────────────────
  const mitmEnabled = cfg?.proxy?.mitm?.enabled ?? false;
  const mitmPort = cfg?.proxy?.mitm?.port ?? 8888;
  if (mitmEnabled) {
    const mitmAlive = probeRoot(mitmPort, 'mitmproxy');
    const logPath = join(homeDir, '.myelin', 'mitmproxy.log');
    sections.push({
      title: `mitmproxy  (:${mitmPort})  — Copilot CLI`,
      print(logFn) {
        if (!mitmAlive) {
          logFn('  ⚠  not running — run: myelin restart');
          return;
        }
        if (!pathExists(logPath)) {
          logFn('  running  (no log data yet — start a Copilot session)');
          return;
        }
        const d = parseMitmLog(logPath, readFile);
        if (d.reqCount === 0) {
          logFn('  running  (no compressed requests yet)');
          return;
        }
        row(logFn, 'Status:', 'running');
        row(logFn, 'Requests compressed:', `${d.reqCount}  (processed ${d.processedGb} GB)`);
        row(logFn, 'Avg compression:', `${d.avgPct}%  (${d.savedMb} MB saved)`);
        if (d.toolFilterCount > 0) {
          const toolPct = ((d.totalToolsBefore - d.totalToolsAfter) / d.totalToolsBefore * 100).toFixed(0);
          row(logFn, 'Tool filtering:', `avg ${Math.round(d.totalToolsBefore / d.toolFilterCount)}→${Math.round(d.totalToolsAfter / d.toolFilterCount)} defs/req  (${toolPct}% stripped)`);
        }
        if (d.lastTimestamp) row(logFn, 'Last request:', d.lastTimestamp);
        if (d.usageCount > 0) {
          row(logFn, 'API calls logged:', `${d.usageCount}  (cost $${d.totalCostUsd.toFixed(3)})`);
          if (d.totalCacheRead > 0 || d.totalCacheWrite > 0) {
            row(logFn, 'Cache tokens:', `read ${(d.totalCacheRead / 1000).toFixed(0)}K  write ${(d.totalCacheWrite / 1000).toFixed(0)}K`);
          }
          if (d.topModels.length > 0) {
            row(logFn, 'Models seen:', d.topModels.map(([m, n]) => `${m} (${n})`).join(', '));
          }
        }
        if (d.topHosts.length > 0) {
          row(logFn, 'Top provider:', d.topHosts.map(([h, n]) => `${h.replace('api.', '').replace('.com', '')} (${n})`).join(', '));
        }
        if (d.errorCount > 0) logFn(`  ⚠  ${d.errorCount} errors in log`);
      },
    });
  }

  if (copilotHeadroomSection) sections.push(copilotHeadroomSection);

  // ── Render ─────────────────────────────────────────────────────────────────
  log('\nMyelin Compression Statistics');
  if (sections.length === 0) {
    log(SEP);
    log('  No services configured. Run: myelin install --yes');
  } else {
    for (const s of sections) {
      log(SEP);
      log(`  ${s.title}`);
      s.print(log);
    }
    const wideHint = !wide ? getWideStatsHint(cfg) : null;
    if (wideHint) {
      log(SEP);
      log(`  ${wideHint}`);
    }
  }
  log(SEP + '\n');
}
