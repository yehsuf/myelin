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

    // Parse compression lines: "[HH:MM:SS.mmm] [myelin] ✓ <host> <before>→<after>B (<pct>%)"
    const compRe = /\[myelin\] ✓ (\S+) (\d+)→(\d+)B \(([\d.]+)%\)/;
    // Parse tool filter lines: "[...] [myelin] tools <before>→<after>"
    const toolRe = /\[myelin\] tools (\d+)→(\d+)/;

    let totalBefore = 0, totalAfter = 0, reqCount = 0;
    let totalToolsBefore = 0, totalToolsAfter = 0, toolFilterCount = 0;
    const byHost = {};

    for (const line of lines) {
      const cm = compRe.exec(line);
      if (cm) {
        const [, host, before, after] = cm;
        const b = parseInt(before), a = parseInt(after);
        totalBefore += b; totalAfter += a; reqCount++;
        byHost[host] = byHost[host] ?? { before: 0, after: 0, count: 0 };
        byHost[host].before += b; byHost[host].after += a; byHost[host].count++;
      }
      const tm = toolRe.exec(line);
      if (tm) {
        totalToolsBefore += parseInt(tm[1]);
        totalToolsAfter  += parseInt(tm[2]);
        toolFilterCount++;
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
      console.log(`  Bytes sent:           ${(totalBefore/1024).toFixed(0)} KB → ${(totalAfter/1024).toFixed(0)} KB`);
      console.log(`  Total saved:          ${savedKB} KB  (${pct}% reduction)`);

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
    const cfg = await loadConfig();
    const port = cfg.proxy.headroom.port;
    const out = execSync(`headroom perf 2>/dev/null`, { timeout: 5000 }).toString();
    // Extract summary lines
    const summaryLines = out.split('\n')
      .filter(l => /Requests:|Tokens:|Total saved:|Window:/.test(l))
      .map(l => '  ' + l.trim());
    console.log(summaryLines.join('\n'));
  } catch {
    console.log('  headroom perf unavailable');
  }

  console.log('─'.repeat(60) + '\n');
}
