import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { execSync } from 'node:child_process';
import { loadConfig } from '../config/reader.mjs';

export async function runStats() {
  const home = homedir();
  const logPath = join(home, '.tokenstack', 'mitmproxy.log');

  // --- mitmproxy stats (Copilot) ---
  console.log('\nMyelin Compression Statistics\n' + '─'.repeat(60));

  if (!existsSync(logPath)) {
    console.log('  No mitmproxy log found. Run _copilot first.\n');
  } else {
    const lines = readFileSync(logPath, 'utf8').split('\n');

    // Parse compression lines: "[...] [myelin] ✓ <host> <b>→<a>B (<pct>%) tokens <tb>→<ta> (<tpct>%)"
    const compRe = /\[myelin\] ✓ (\S+) (\d+)→(\d+)B \(([\d.]+)%\)(?: tokens (\d+)→(\d+))?/;
    // Parse tool filter lines
    const toolRe = /\[myelin\] tools (\d+)→(\d+)/;
    // Parse actual API usage (cost pre-computed by addon at log time):
    // "[myelin] usage <host> in=N out=N cache_read=N cache_write=N cost=$N saved=$N model=M"
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
      const tm = toolRe.exec(line);
      if (tm) {
        totalToolsBefore += parseInt(tm[1]);
        totalToolsAfter  += parseInt(tm[2]);
        toolFilterCount++;
      }
      const um = usageRe.exec(line);
      if (um) {
        totalIn         += parseInt(um[1]);
        totalOut        += parseInt(um[2]);
        totalCacheRead  += parseInt(um[3]);
        totalCacheWrite += parseInt(um[4]);
        totalCostUsd    += parseFloat(um[5]);
        totalSavedUsd   += parseFloat(um[6]);
        usageCount++;
      }
    }

    if (reqCount === 0) {
      console.log('  No compressed requests yet. Run _copilot first.\n');
    } else {
      const savedBytes = totalBefore - totalAfter;
      const pct = (savedBytes / totalBefore * 100).toFixed(1);
      const savedKB = (savedBytes / 1024).toFixed(0);

      console.log(`\n  Copilot (via mitmproxy :8888)`);
      console.log(`  Requests compressed:  ${reqCount}`);
      console.log(`  Bytes sent:           ${(totalBefore/1024).toFixed(0)} KB → ${(totalAfter/1024).toFixed(0)} KB  (${pct}%)`);
      if (tokCount > 0) {
        const tokSaved = totalTokBefore - totalTokAfter;
        const tokPct = (tokSaved / totalTokBefore * 100).toFixed(1);
        console.log(`  Tokens compressed:    ${(totalTokBefore/1000).toFixed(0)}K → ${(totalTokAfter/1000).toFixed(0)}K  (${tokPct}% reduction)`);
      } else {
        console.log(`  Bytes saved:          ${savedKB} KB  (${pct}% — restart _copilot to see token counts)`);
      }
      if (usageCount > 0) {
        console.log(`  Actual API usage:     in=${(totalIn/1000).toFixed(0)}K  out=${(totalOut/1000).toFixed(0)}K  cache_read=${(totalCacheRead/1000).toFixed(0)}K  cache_write=${(totalCacheWrite/1000).toFixed(0)}K  (${usageCount} responses)`);
      }

      if (toolFilterCount > 0) {
        const toolPct = ((totalToolsBefore - totalToolsAfter) / totalToolsBefore * 100).toFixed(0);
        console.log(`  Tools filtered:       avg ${Math.round(totalToolsBefore/toolFilterCount)}→${Math.round(totalToolsAfter/toolFilterCount)} per request (${toolPct}% reduction)`);
      }

      if (Object.keys(byHost).length > 1) {
        console.log('\n  By host:');
        for (const [host, s] of Object.entries(byHost)) {
          const p = ((s.before - s.after) / s.before * 100).toFixed(1);
          console.log(`    ${host.padEnd(40)} ${s.count} reqs  ${p}%`);
        }
      }
    }
  }

  // --- headroom stats (Claude Code) ---
  console.log('\n' + '─'.repeat(60));
  console.log('  Claude Code (via headroom :8787)');
  try {
    const statsUrl = 'http://127.0.0.1:8787/stats';
    const resp = JSON.parse(execSync(`curl -sf ${statsUrl}`, { timeout: 3000 }).toString());
    const s = resp.summary ?? {};
    const c = s.compression ?? {};
    const cost = s.cost ?? {};
    const bd = cost.breakdown ?? {};
    const reqs = s.api_requests ?? 0;
    const compressed = c.requests_compressed ?? 0;
    const tokBefore = c.total_tokens_before_with_cli_filtering ?? 0;
    const tokSaved = c.total_tokens_saved_with_cli_filtering ?? 0;
    const comprPct = tokBefore > 0 ? (tokSaved / tokBefore * 100).toFixed(1) : '0.0';
    const cacheSavedUsd = bd.cache_savings_usd ?? 0;
    const comprSavedUsd = bd.compression_savings_usd ?? 0;
    const totalSavedUsd = cacheSavedUsd + comprSavedUsd;

    // Get cache hit rate from headroom perf text (not in /stats JSON)
    let cacheHitLine = '';
    try {
      const perf = execSync(`headroom perf 2>/dev/null`, { timeout: 5000 }).toString();
      const hitMatch = perf.match(/Hit rate:\s+([\d.]+%)/);
      const readMatch = perf.match(/Cache read:\s+([\d,]+) tokens/);
      const writeMatch = perf.match(/Cache write:\s+([\d,]+) tokens/);
      if (hitMatch) {
        const read = readMatch ? Math.round(parseInt(readMatch[1].replace(/,/g,''))/1000) + 'K' : '?';
        const write = writeMatch ? Math.round(parseInt(writeMatch[1].replace(/,/g,''))/1000) + 'K' : '?';
        cacheHitLine = `  KV cache hit rate:    ${hitMatch[1]}  (${read} read / ${write} write)`;
      }
    } catch { /* ignore */ }

    console.log(`  Requests:             ${reqs} total, ${compressed} compressed`);
    console.log(`  Text compression:     ${comprPct}%  (${(tokSaved/1000).toFixed(0)}K tokens saved)`);
    if (cacheHitLine) console.log(cacheHitLine);
    console.log(`  Cost saved:           $${totalSavedUsd.toFixed(2)}  (cache $${cacheSavedUsd.toFixed(2)} + compression $${comprSavedUsd.toFixed(2)})`);
    const skipped = (c.prefix_frozen ?? 0) + (c.too_small ?? 0) + (c.no_compressible_content ?? 0);
    if (skipped > 0) {
      console.log(`  ℹ  ${skipped} reqs skipped compression (cache-pinned / too small — cache savings still apply)`);
    }
  } catch {
    // Fall back to headroom perf CLI
    try {
      const out = execSync(`headroom perf 2>/dev/null`, { timeout: 5000 }).toString();
      const lines = out.split('\n')
        .filter(l => /Requests:|Tokens:|Total saved:|Window:|Hit rate:/.test(l))
        .map(l => '  ' + l.trim());
      console.log(lines.join('\n'));
    } catch {
      console.log('  headroom unavailable — is port 8787 running?');
    }
  }

  console.log('─'.repeat(60) + '\n');
}
