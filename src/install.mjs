#!/usr/bin/env node
/**
 * Myelin — complete installer
 * Flags: --profile proxy|mcp|minimal  --index-tier light|default|full
 *        --no-headroom  --no-rtk  --copilot-only  --claude-only
 *        --with-stacklit  --with-litellm  --check  --dry-run
 */
import { parseArgs } from 'node:util';
import { mkdirSync, existsSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { execSync } from 'node:child_process';
import { detectOS, detectShell } from './detect/os.mjs';
import { detectAll } from './detect/tools.mjs';
import { which } from './detect/which.mjs';
import { detectCorporateProxy, detectCaBundles, buildCorporateSslEnv } from './detect/proxy.mjs';
import { isPortFree, findFreePort } from './detect/port.mjs';
import { loadConfig, DEFAULT_CONFIG_PATH } from './config/reader.mjs';
import { writeConfig } from './config/writer.mjs';
import { DEFAULT_CONFIG, mergeDeep } from './config/schema.mjs';
import { ensureUv, uvToolInstall } from './tools/uv.mjs';
import { installHeadroom, waitForHeadroom, headroomBinPath } from './tools/headroom.mjs';
import { installRtk } from './tools/rtk.mjs';
import { installService } from './service/index.mjs';

// helpers
const ok   = m => console.log(`  \u2713 ${m}`);
const skip = m => console.log(`  \u00b7 ${m}`);
const warn = m => console.warn(`  \u26a0 ${m}`);
const step = m => console.log(`\n${m}`);

function backup(path) {
  if (existsSync(path)) {
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    copyFileSync(path, `${path}.bak.${ts}`);
  }
}

function mergeDeepPlain(base, override) {
  if (typeof base !== 'object' || base === null) return override;
  if (typeof override !== 'object' || override === null) return override;
  const r = { ...base };
  for (const k of Object.keys(override)) {
    r[k] = (typeof override[k] === 'object' && !Array.isArray(override[k]) && override[k] !== null)
      ? mergeDeepPlain(base[k] ?? {}, override[k]) : override[k];
  }
  return r;
}

function mergeJsonFile(path, updates, createIfMissing = {}) {
  const current = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : createIfMissing;
  backup(path);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, JSON.stringify(mergeDeepPlain(current, updates), null, 2), 'utf8');
}

const MS = '# >>> myelin managed >>>';
const ME = '# <<< myelin managed <<<';
function writeManagedSection(filePath, content) {
  mkdirSync(join(filePath, '..'), { recursive: true });
  let existing = existsSync(filePath) ? readFileSync(filePath, 'utf8') : '';
  const block = `${MS}\n${content}\n${ME}`;
  const si = existing.indexOf(MS), ei = existing.indexOf(ME);
  if (si !== -1 && ei !== -1) {
    existing = existing.slice(0, si) + block + existing.slice(ei + ME.length);
  } else {
    existing = existing + (existing.endsWith('\n') ? '' : '\n') + '\n' + block + '\n';
  }
  backup(filePath);
  writeFileSync(filePath, existing, 'utf8');
}

async function detectHeadroomFork() {
  const candidates = [
    join(homedir(), 'Work', 'headroom', '.venv13', 'bin', 'headroom'),
    join(homedir(), 'Work', 'headroom', '.venv', 'bin', 'headroom'),
    join(homedir(), 'headroom', '.venv', 'bin', 'headroom'),
  ];
  for (const p of candidates) {
    if (existsSync(p)) return { path: p, source: 'local-fork' };
  }
  const inPath = await which('headroom');
  if (inPath) return { path: inPath, source: 'path' };
  return null;
}

function shellProfilePath(os, shell) {
  if (os === 'windows') return null;
  if (shell.includes('zsh'))  return join(homedir(), '.zshrc');
  if (shell.includes('bash')) return join(homedir(), '.bashrc');
  if (shell.includes('fish')) return join(homedir(), '.config', 'fish', 'config.fish');
  return join(homedir(), '.profile');
}

function installHooks(dir) {
  writeFileSync(join(dir, 'discovery-gate.mjs'), `#!/usr/bin/env node
// Myelin: gates raw file reads until Serena is used once
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
const ppid = process.ppid ?? 'x';
const used = join(tmpdir(), \`myelin-serena-used-\${ppid}\`);
const once = join(tmpdir(), \`myelin-blocked-\${ppid}\`);
let input = {};
try { input = JSON.parse(readFileSync('/dev/stdin', 'utf8')); } catch {}
const tool = input?.tool_name ?? '';
if (['Read','Grep','Glob','Search'].includes(tool) && !existsSync(used) && !existsSync(once)) {
  writeFileSync(once, '1');
  process.stderr.write('[myelin] Use serena_find_symbol first. Gate disarms after one Serena call.\\n');
  process.exit(2);
}
process.exit(0);
`);

  writeFileSync(join(dir, 'serena-marker.mjs'), `#!/usr/bin/env node
// Myelin: disarms discovery-gate after Serena is used
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
let input = {};
try { input = JSON.parse(readFileSync('/dev/stdin', 'utf8')); } catch {}
if ((input?.tool_name ?? '').toLowerCase().includes('serena')) {
  writeFileSync(join(tmpdir(), \`myelin-serena-used-\${process.ppid ?? 'x'}\`), '1');
}
process.exit(0);
`);

  writeFileSync(join(dir, 'bash-ban-raw.mjs'), `#!/usr/bin/env node
// Myelin: advisory warning on raw cat/grep/find in Bash
import { readFileSync } from 'node:fs';
let input = {};
try { input = JSON.parse(readFileSync('/dev/stdin', 'utf8')); } catch {}
if (input?.tool_name === 'Bash') {
  const cmd = input?.tool_input?.command ?? '';
  if (/\\bcat |\\bgrep |\\bfind |\\bhead |\\btail |\\bwc /.test(cmd)) {
    process.stderr.write('[myelin] Prefer serena_search_for_pattern_in_files over raw shell search.\\n');
  }
}
process.exit(0);
`);
}

function printStateTable(tools, forkHeadroom, caBundles, proxy) {
  console.log('\nCurrent State\n' + '─'.repeat(60));
  for (const [name, r] of Object.entries(tools)) {
    const icon = r.installed ? '\u2713' : '\u2717';
    console.log(`  ${icon} ${name.padEnd(14)} ${r.installed ? r.version : 'not installed'}`);
  }
  if (forkHeadroom) console.log(`\n  Headroom fork:  ${forkHeadroom.path}`);
  if (caBundles.length) console.log(`  CA bundles:     ${caBundles.map(b => b.source).join(', ')}`);
  if (proxy) console.log(`  Upstream proxy: ${proxy}`);
  console.log('─'.repeat(60) + '\n');
}

async function main() {
  const { values: flags } = parseArgs({
    options: {
      profile:         { type: 'string',  default: 'proxy' },
      'index-tier':    { type: 'string',  default: 'default' },
      'no-headroom':   { type: 'boolean', default: false },
      'no-rtk':        { type: 'boolean', default: false },
      'copilot-only':  { type: 'boolean', default: false },
      'claude-only':   { type: 'boolean', default: false },
      'with-stacklit': { type: 'boolean', default: false },
      'with-litellm':  { type: 'boolean', default: false },
      check:           { type: 'boolean', default: false },
      'dry-run':       { type: 'boolean', default: false },
    },
    strict: false,
  });

  const os       = detectOS();
  const shell    = detectShell();
  const home     = homedir();
  const claudeCC = !flags['copilot-only'];
  const copilot  = !flags['claude-only'];

  console.log('\n\ud83e\uddec Myelin Installer \u2014 ' + os + '\n');
  console.log('Detecting existing installations...');

  const tools        = await detectAll();
  const { proxy: corpProxy } = detectCorporateProxy();
  const caBundles    = detectCaBundles();
  const sslEnv       = buildCorporateSslEnv(caBundles[0]?.path ?? null);
  const forkHeadroom = await detectHeadroomFork();

  if (flags.check) { printStateTable(tools, forkHeadroom, caBundles, corpProxy); process.exit(0); }

  mkdirSync(join(home, '.tokenstack'), { recursive: true });
  const existingCfg = await loadConfig(DEFAULT_CONFIG_PATH);
  let port = existingCfg.proxy.headroom.port;
  if (!(await isPortFree(port))) {
    // Port in use — check if it's already our Headroom proxy (healthy → keep it)
    const alreadyOurs = await import('./tools/headroom.mjs').then(m => m.waitForHeadroom(port, 1500)).catch(() => false);
    if (alreadyOurs) {
      ok(`Headroom already running on port ${port} — keeping`);
    } else {
      warn(`Port ${port} in use by another process. Finding a free port...`);
      port = await findFreePort(port + 1, port + 20);
      ok(`Using port ${port}`);
    }
  }

  if (flags['dry-run']) {
    console.log('\n[dry-run] Would install / configure:');
    console.log('  uv, serena, semble, ast-grep, rtk');
    if (!flags['no-headroom']) console.log(forkHeadroom
      ? `  headroom — use existing fork at ${forkHeadroom.path}`
      : '  headroom-ai[all] (yehsuf fork, fallback PyPI)');
    if (flags.profile === 'proxy') console.log(`  service on port ${port}`);
    if (claudeCC) console.log('  ~/.claude/settings.json, CLAUDE.md, hooks');
    if (copilot)  console.log('  ~/.copilot/mcp-config.json');
    console.log('  shell profile ANTHROPIC_BASE_URL');
    console.log('\n[dry-run] No changes made.\n');
    return;
  }

  // 1. Package manager
  step('[1/7] Package manager...');
  await ensureUv();
  ok('uv ready');

  // 2. Code discovery tools
  step('[2/7] Code discovery tools...');
  if (!tools.serena.installed) {
    console.log('  Installing Serena...'); uvToolInstall('serena'); ok('serena installed');
  } else { skip(`serena (${tools.serena.version})`); }

  if (!tools.semble.installed) {
    console.log('  Installing Semble...'); uvToolInstall('semble');
    try {
      execSync(`semble install ${claudeCC ? '--agent claude --type mcp subagent' : ''} --yes`, { stdio: 'pipe' });
    } catch {}
    ok('semble installed');
  } else { skip('semble (installed)'); }

  if (!tools.astgrep.installed) {
    console.log('  Installing ast-grep...');
    if (os !== 'windows') {
      try { execSync('brew install ast-grep', { stdio: 'inherit' }); ok('ast-grep (brew)'); }
      catch { execSync('cargo install ast-grep --locked', { stdio: 'inherit' }); ok('ast-grep (cargo)'); }
    } else {
      try { execSync('cargo install ast-grep --locked', { stdio: 'inherit' }); ok('ast-grep (cargo)'); }
      catch { warn('ast-grep install failed — install manually'); }
    }
  } else { skip(`ast-grep (${tools.astgrep.version})`); }

  // 3. Proxy backbone
  step('[3/7] Proxy backbone...');
  if (!flags['no-headroom']) {
    if (forkHeadroom) {
      ok(`headroom — using ${forkHeadroom.source}: ${forkHeadroom.path}`);
    } else if (!tools.headroom.installed) {
      console.log('  Installing headroom (yehsuf fork)...');
      const venv = join(home, '.tokenstack', 'venv');
      execSync(`uv venv ${venv}`, { stdio: 'pipe' });
      try {
        execSync(`uv pip install --python ${venv} "headroom-ai[all] @ git+https://github.com/yehsuf/headroom.git"`, { stdio: 'inherit' });
        ok('headroom installed (yehsuf fork)');
      } catch {
        warn('Fork install failed — using PyPI headroom-ai');
        execSync(`uv pip install --python ${venv} "headroom-ai[all]"`, { stdio: 'inherit' });
        ok('headroom installed (PyPI)');
      }
    } else { skip(`headroom (${tools.headroom.version})`); }
  }

  if (!flags['no-rtk']) {
    if (!tools.rtk.installed) { console.log('  Installing RTK...'); await installRtk(os); }
    else { skip(`rtk (${tools.rtk.version})`); }
  }

  // 4. Service
  if (!flags['no-headroom'] && flags.profile === 'proxy') {
    step('[4/7] Background service...');
    const binPath = forkHeadroom?.path ?? headroomBinPath();
    const envVars = { HEADROOM_PORT: String(port), ...sslEnv };
    if (corpProxy) envVars.HTTPS_PROXY = corpProxy;
    await installService({ headroomBin: binPath, port, envVars,
      logPath: join(home, '.tokenstack', 'headroom.log') });
    ok(`service registered (port ${port})`);
    console.log('  Waiting for proxy...');
    const healthy = await waitForHeadroom(port, 10000);
    healthy ? ok(`proxy healthy on :${port}`) : warn(`no response — run: myelin diagnose`);
  } else {
    step('[4/7] Service: skipped');
  }

  // 5. Config files
  step('[5/7] Configuration files...');

  // ~/.tokenstack/config.yaml
  if (!existsSync(DEFAULT_CONFIG_PATH)) {
    await writeConfig(mergeDeep(DEFAULT_CONFIG, {
      proxy: { headroom: { port, corporate_proxy: corpProxy } },
      index_tier: flags['index-tier'],
    }), DEFAULT_CONFIG_PATH);
    ok(`config.yaml created`);
  } else { skip('config.yaml already exists'); }

  // Claude Code settings.json
  if (claudeCC) {
    mergeJsonFile(join(home, '.claude', 'settings.json'), {
      env: {
        ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`,
        ENABLE_PROMPT_CACHING_1H: '1',
        CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: '50',
        CLAUDE_CODE_SUBAGENT_MODEL: 'claude-sonnet-4-6',
        HEADROOM_PORT: String(port),
        ...sslEnv,
      },
      mcpServers: {
        serena:    { command: 'serena', args: ['--project', '.'] },
        semble:    { command: 'semble', args: ['mcp'] },
        'mcp-git': { command: 'uvx', args: ['mcp-server-git', '--repository', '.'] },
        mem0:      { command: 'uvx', args: ['mem0-mcp'] },
      },
    }, {});
    ok('~/.claude/settings.json (MCPs + proxy env)');
  }

  // Copilot CLI mcp-config.json
  if (copilot) {
    const mcp = join(home, '.copilot', 'mcp-config.json');
    if (existsSync(mcp)) {
      mergeJsonFile(mcp, { servers: {
        serena:    { type: 'local', command: 'serena', args: ['--project', '.'], env: {}, tools: ['*'] },
        semble:    { type: 'local', command: 'semble', args: ['mcp'],            env: {}, tools: ['*'] },
        'mcp-git': { type: 'local', command: 'uvx', args: ['mcp-server-git', '--repository', '.'], env: {}, tools: ['*'] },
        mem0:      { type: 'local', command: 'uvx', args: ['mem0-mcp'],          env: {}, tools: ['*'] },
      }});
      ok('~/.copilot/mcp-config.json (MCPs)');
    } else { skip('~/.copilot/mcp-config.json not found'); }
  }

  // CLAUDE.md managed section
  if (claudeCC) {
    writeManagedSection(join(home, '.claude', 'CLAUDE.md'),
`\n## Code Navigation Protocol (Myelin)\n1. Before ANY file read or grep, call \`serena_find_symbol\` or \`serena_get_symbols_overview\`.\n2. For semantic/intent queries, call \`semble_search\`.\n3. For cross-file patterns, use astgrep — not grep loops.\n4. For code review, call \`mcp-git.git_diff\` / \`mcp-git.git_show\` instead of reading both files.\n5. Never use raw \`cat\`, \`grep\`, \`find\`, \`head\`, \`tail\` in Bash.\n\n## Output Protocol\n- Terse. No preamble. Patch format. No emoji.\n\n## Session\n- /compact when context > 50%. Headroom proxy on port ${port}.`);
    ok('~/.claude/CLAUDE.md managed section');
  }

  // Shell profile
  const profilePath = shellProfilePath(os, shell);
  if (profilePath) {
    const existing = existsSync(profilePath) ? readFileSync(profilePath, 'utf8') : '';
    if (!existing.includes('myelin managed')) {
      writeFileSync(profilePath,
        existing + `\n# >>> myelin managed >>>\nexport HEADROOM_PORT=${port}\nexport ANTHROPIC_BASE_URL="http://127.0.0.1:\${HEADROOM_PORT}"\nalias myelin="node \${HOME}/.tokenstack/repo/bin/tokenstack"\n# <<< myelin managed <<<\n`, 'utf8');
      ok(`${profilePath} (ANTHROPIC_BASE_URL, myelin alias)`);
    } else { skip(`${profilePath} already configured`); }
  }

  // 6. Hooks
  if (claudeCC) {
    step('[6/7] Enforcement hooks...');
    const hooksDir = join(home, '.claude', 'hooks');
    mkdirSync(hooksDir, { recursive: true });
    installHooks(hooksDir);
    ok('discovery-gate.mjs, serena-marker.mjs, bash-ban-raw.mjs');
  } else { step('[6/7] Hooks: skipped (--copilot-only)'); }

  // 7. Summary
  step('[7/7] Complete! \ud83e\uddec\n' + '\u2500'.repeat(55));
  console.log(`  Proxy port:    ${port}`);
  console.log(`  Headroom:      ${forkHeadroom ? forkHeadroom.path : headroomBinPath()}`);
  console.log(`  Config:        ${DEFAULT_CONFIG_PATH}`);
  if (caBundles.length) console.log(`  Corporate SSL: ${caBundles[0].path}`);
  console.log('\n  \u26a0 Start a new terminal/session for all changes to take effect.');
  console.log('\n  myelin verify          \u2192 health check');
  console.log('  myelin config show     \u2192 view settings');
  console.log('  myelin update --check  \u2192 available updates');
  console.log('\u2500'.repeat(55) + '\n');
}

main().catch(e => { console.error(e); process.exit(1); });
