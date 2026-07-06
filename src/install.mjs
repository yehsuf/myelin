#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { detectOS } from './detect/os.mjs';
import { detectAll } from './detect/tools.mjs';
import { detectCorporateProxy, detectCaBundles, buildCorporateSslEnv } from './detect/proxy.mjs';
import { isPortFree, findFreePort } from './detect/port.mjs';
import { loadConfig, DEFAULT_CONFIG_PATH } from './config/reader.mjs';
import { writeConfig } from './config/writer.mjs';
import { DEFAULT_CONFIG, mergeDeep } from './config/schema.mjs';
import { ensureUv } from './tools/uv.mjs';
import { installHeadroom, waitForHeadroom, headroomBinPath } from './tools/headroom.mjs';
import { installRtk } from './tools/rtk.mjs';
import { installService } from './service/index.mjs';

async function main() {
  const { values: flags } = parseArgs({
    options: {
      profile:        { type: 'string',  default: 'proxy' },
      'index-tier':   { type: 'string',  default: 'default' },
      'no-headroom':  { type: 'boolean', default: false },
      'no-rtk':       { type: 'boolean', default: false },
      'copilot-only': { type: 'boolean', default: false },
      'claude-only':  { type: 'boolean', default: false },
      'with-stacklit':{ type: 'boolean', default: false },
      'with-litellm': { type: 'boolean', default: false },
      check:          { type: 'boolean', default: false },
      'dry-run':      { type: 'boolean', default: false },
    },
    strict: false,
  });

  const os = detectOS();
  console.log(`\n🛠  TokenStack Installer — ${os}\n`);
  console.log('Detecting existing installations...');
  const tools = await detectAll();
  const { proxy: corpProxy } = detectCorporateProxy();
  const caBundles = detectCaBundles();
  const sslEnv = buildCorporateSslEnv(caBundles[0]?.path ?? null);

  if (flags.check) { printStateTable(tools, caBundles, corpProxy); process.exit(0); }

  mkdirSync(join(homedir(), '.tokenstack'), { recursive: true });

  const existingCfg = await loadConfig(DEFAULT_CONFIG_PATH);
  let port = existingCfg.proxy.headroom.port;
  if (!(await isPortFree(port))) {
    console.warn(`⚠ Port ${port} in use. Finding a free port...`);
    port = await findFreePort(port + 1, port + 20);
    console.log(`  → Using port ${port}`);
  }

  if (flags['dry-run']) {
    console.log('\n[dry-run] Would install:');
    console.log('  uv (package manager)');
    if (!flags['no-headroom']) console.log('  headroom-ai[all] (proxy backbone)');
    if (!flags['no-rtk'])      console.log('  rtk (shell compression)');
    console.log('  Service management for:', os);
    console.log('\n[dry-run] No changes made.\n');
    return;
  }

  console.log('\n[1/5] Installing core tools...');
  await ensureUv();
  if (!flags['no-headroom']) {
    if (!tools.headroom.installed) { console.log('  Installing headroom-ai...'); await installHeadroom(); }
    else console.log(`  ✓ headroom already installed (${tools.headroom.version})`);
  }
  if (!flags['no-rtk']) {
    if (!tools.rtk.installed) { console.log('  Installing RTK...'); await installRtk(os); }
    else console.log(`  ✓ RTK already installed (${tools.rtk.version})`);
  }

  console.log('\n[2/5] Writing configuration...');
  const newConfig = mergeDeep(DEFAULT_CONFIG, {
    proxy: { headroom: { port, corporate_proxy: corpProxy } },
    index_tier: flags['index-tier'],
  });
  if (!existsSync(DEFAULT_CONFIG_PATH)) {
    await writeConfig(newConfig, DEFAULT_CONFIG_PATH);
    console.log(`  ✓ Created ${DEFAULT_CONFIG_PATH}`);
  } else {
    console.log(`  ✓ Config exists at ${DEFAULT_CONFIG_PATH} — preserved`);
  }
  if (caBundles.length > 0) console.log(`  ✓ Detected ${caBundles.length} CA bundle(s) — corporate SSL configured`);

  if (!flags['no-headroom'] && flags.profile === 'proxy') {
    console.log('\n[3/5] Installing background service...');
    const binPath = headroomBinPath();
    const envVars = { HEADROOM_PORT: String(port), ...sslEnv };
    if (corpProxy) envVars.HTTPS_PROXY = corpProxy;
    await installService({ headroomBin: binPath, port, envVars, logPath: join(homedir(), '.tokenstack', 'headroom.log') });
    console.log(`  ✓ Service installed — proxy starting on port ${port}`);
    console.log('  Waiting for proxy to be ready...');
    const healthy = await waitForHeadroom(port, 10000);
    console.log(healthy ? `  ✓ Proxy healthy on :${port}` : `  ⚠ Proxy did not respond in 10s — run: tokenstack diagnose`);
  } else {
    console.log('\n[3/5] Service install: skipped (profile != proxy or --no-headroom)');
  }

  console.log('\n[4/5] Tool installs complete.');
  console.log('\n[5/5] Summary\n' + '─'.repeat(50));
  console.log(`  Proxy port:    ${port}`);
  console.log(`  Config:        ${DEFAULT_CONFIG_PATH}`);
  console.log(`  Profile:       ${flags.profile}`);
  console.log(`  Index tier:    ${flags['index-tier']}`);
  if (caBundles.length) console.log(`  Corporate SSL: ${caBundles[0].path}`);
  console.log('\n  Next steps:');
  console.log('    tokenstack verify          → check all components');
  console.log('    tokenstack config show     → view your settings');
  console.log('    tokenstack update --check  → see if updates are available');
  console.log('─'.repeat(50) + '\n');
}

function printStateTable(tools, caBundles, proxy) {
  console.log('\nCurrent State\n' + '─'.repeat(55));
  for (const [name, r] of Object.entries(tools)) {
    const icon = r.installed ? '✓' : '✗';
    console.log(`  ${icon} ${name.padEnd(12)} ${r.installed ? r.version : 'not installed'}`);
  }
  if (caBundles.length) console.log(`\n  Corporate CA bundles found: ${caBundles.map(b => b.source).join(', ')}`);
  if (proxy) console.log(`  Upstream proxy: ${proxy}`);
  console.log('─'.repeat(55) + '\n');
}

main().catch(e => { console.error(e); process.exit(1); });
