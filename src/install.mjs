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
import { createInterface as createRL } from 'node:readline';
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
import { installService, installMitmService } from './service/index.mjs';

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
  // Kept for detecting already-installed local dev builds — uses them as-is, doesn't prefer them
  const candidates = [
    join(homedir(), 'Work', 'headroom', '.venv13', 'bin', 'headroom'),
    join(homedir(), 'Work', 'headroom', '.venv', 'bin', 'headroom'),
  ];
  for (const p of candidates) {
    if (existsSync(p)) return { path: p, source: 'local-dev' };
  }
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

function printStateTable(tools, caBundles, proxy) {
  console.log('\nCurrent State\n' + '─'.repeat(60));
  for (const [name, r] of Object.entries(tools)) {
    const icon = r.installed ? '\u2713' : '\u2717';
    console.log(`  ${icon} ${name.padEnd(14)} ${r.installed ? r.version : 'not installed'}`);
  }
  if (caBundles.length) console.log(`  CA bundles:     ${caBundles.map(b => b.source).join(', ')}`);
  if (proxy) console.log(`  Upstream proxy: ${proxy}`);
  console.log('─'.repeat(60) + '\n');
}

/**
 * Build a combined CA bundle: the detected root CA + the intermediate CA
 * extracted from the live TLS connection to api.github.com.
 * Required when a corporate SSL interceptor (e.g. NetFree/Hot) uses an
 * intermediate CA that isn't in the standard trust store.
 * Returns the path to the combined cert, or the original path if no
 * interception is detected or extraction fails.
 */
async function buildCombinedCaCert(rootCaPath, home) {
  if (!rootCaPath) return null;
  const combinedPath = join(home, '.tokenstack', 'ca-bundle.pem');

  try {
    const intermediate = execSync(
      `echo | openssl s_client -connect api.github.com:443 -showcerts 2>/dev/null | ` +
      `awk '/-----BEGIN CERTIFICATE-----/{i++} i==2{print} /-----END CERTIFICATE-----/ && i==2{exit}'`,
      { shell: true, timeout: 10000 }
    ).toString().trim();

    if (!intermediate.includes('BEGIN CERTIFICATE')) return rootCaPath;

    const rootContent = readFileSync(rootCaPath, 'utf8');
    // Check if intermediate is already present (avoid duplicates)
    const intermediateLine = intermediate.split('\n')[1]?.trim() ?? '';
    if (intermediateLine && rootContent.includes(intermediateLine)) return rootCaPath;

    writeFileSync(
      combinedPath,
      rootContent + '\n# Intermediate CA (auto-extracted from live TLS chain)\n' + intermediate + '\n',
      'utf8'
    );
    return combinedPath;
  } catch {
    return rootCaPath;
  }
}

/**
 * Install mitmproxy CA into all PEM bundles referenced by env vars.
 * Detects locations from NODE_EXTRA_CA_CERTS, SSL_CERT_FILE, REQUESTS_CA_BUNDLE,
 * HEADROOM_CA_BUNDLE, GIT_SSL_CAINFO, CURL_CA_BUNDLE. Prompts user per file.
 * Creates ~/.tokenstack/ca-bundle.pem if none exists.
 *
 * Interactive: shows exact file path and asks Y/n for each.
 */
async function installMitmproxyCA(home, interactive = true) {
  const mitmCaPath = join(home, '.mitmproxy', 'mitmproxy-ca-cert.pem');
  if (!existsSync(mitmCaPath)) {
    skip('mitmproxy CA not found (run: mitmdump --listen-port 18899 briefly to generate)');
    return;
  }

  // Detect all PEM candidates from env
  const candidates = new Set();
  const envVars = ['NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'REQUESTS_CA_BUNDLE',
                   'HEADROOM_CA_BUNDLE', 'GIT_SSL_CAINFO', 'CURL_CA_BUNDLE'];
  for (const v of envVars) {
    const p = process.env[v];
    if (p && existsSync(p)) candidates.add(p);
  }

  // Fallback: create/use ~/.tokenstack/ca-bundle.pem
  if (candidates.size === 0) {
    const fallback = join(home, '.tokenstack', 'ca-bundle.pem');
    if (!existsSync(fallback)) {
      mkdirSync(join(home, '.tokenstack'), { recursive: true });
      try {
        const sysCerts = execSync('security find-certificate -a -p /Library/Keychains/SystemRootCertificates.keychain 2>/dev/null || cat /etc/ssl/cert.pem 2>/dev/null', { shell: true }).toString();
        writeFileSync(fallback, sysCerts);
      } catch {
        writeFileSync(fallback, '');
      }
      ok(`Created new CA bundle at ${fallback}`);
    }
    candidates.add(fallback);
  }

  const mitmCert = readFileSync(mitmCaPath, 'utf8');
  const mitmMarker = 'CN=mitmproxy';

  for (const pemPath of candidates) {
    const content = readFileSync(pemPath, 'utf8');
    if (content.includes(mitmMarker)) {
      skip(`${pemPath} — already trusts mitmproxy CA`);
      continue;
    }

    if (interactive) {
      const answer = await promptYN(`Add mitmproxy CA to ${pemPath}? [Y/n]: `);
      if (!answer) { skip(`${pemPath} — user declined`); continue; }
    }

    // Backup + append
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    copyFileSync(pemPath, `${pemPath}.bak.${ts}`);
    writeFileSync(pemPath,
      content + '\n# mitmproxy CA (for Copilot HTTPS interception via Myelin)\n' + mitmCert + '\n',
      'utf8');
    ok(`${pemPath} — added mitmproxy CA (backup: ${pemPath}.bak.${ts})`);
  }
}

// Shared readline instance — created once, reused across all prompts.
// Auto-accepts (returns true) when stdin is not a TTY or --yes flag is set.
let _rl = null;

async function promptYN(question) {
  if (!process.stdin.isTTY || process.argv.includes('--yes') || process.argv.includes('-y')) {
    process.stdout.write(question + ' [auto: Y]\n');
    return true;
  }
  if (!_rl) _rl = createRL({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => {
    _rl.question(question, ans => {
      const a = ans.trim().toLowerCase();
      resolve(a === '' || a === 'y' || a === 'yes');
    });
  });
}

function _closeRL() { if (_rl) { _rl.close(); _rl = null; } }

/**
 * Return the path to the Myelin mitmproxy addon script.
 * Resolves relative to the tokenstack repo root so it works on all platforms.
 */
function mitmAddonPath(home) {
  return join(home, 'tokenstack', 'src', 'mitm', 'copilot_addon.py');
}

/**
 * Detect the mitmdump binary path (cross-platform).
 * Checks existence for absolute paths, then tries running --version.
 */
function detectMitmdump(os) {
  const candidates =
    os === 'windows'
      ? [
          'mitmdump',
          join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Python', 'Scripts', 'mitmdump.exe'),
          join(process.env.APPDATA ?? '', 'Python', 'Scripts', 'mitmdump.exe'),
        ]
      : [
          '/opt/homebrew/bin/mitmdump',
          '/usr/local/bin/mitmdump',
          '/usr/bin/mitmdump',
          join(homedir(), '.local', 'bin', 'mitmdump'),
          'mitmdump',
        ];

  for (const c of candidates) {
    const isAbsolute = c.startsWith('/') || c.includes('\\');
    if (isAbsolute && !existsSync(c)) continue;
    try {
      execSync(`"${c}" --version`, { stdio: 'pipe', timeout: 5000 });
      return c;
    } catch {
      // binary exists but --version failed or timed out; still usable
      if (isAbsolute && existsSync(c)) return c;
    }
  }
  return null;
}

/**
 * Install mitmproxy (mitmdump) if not present.
 * Mac: brew. Windows: pip (pipx). Linux: pip via uv.
 * Returns the mitmdump binary path.
 */
async function ensureMitmproxy(os) {
  let bin = detectMitmdump(os);
  if (bin) return bin;

  console.log('  Installing mitmproxy…');
  try {
    if (os === 'darwin') {
      // brew exits non-zero if already installed via different formula; ignore exit code
      try { execSync('brew install mitmproxy', { stdio: 'inherit' }); } catch {}
    } else if (os === 'windows') {
      try { execSync('pip install --user mitmproxy', { stdio: 'inherit' }); } catch {}
    } else {
      try { execSync('pip install --user mitmproxy', { stdio: 'inherit' }); } catch {}
    }
  } catch {}

  bin = detectMitmdump(os);
  if (bin) { ok(`mitmproxy (${bin})`); return bin; }
  warn('mitmdump not found after install — install manually: brew install mitmproxy');
  return null;
}

/**
 * Generate the mitmproxy CA (runs mitmdump briefly if CA does not exist).
 * Returns the CA cert path, or null.
 */
async function ensureMitmCA(home, mitmdumpBin) {
  const caPath = join(home, '.mitmproxy', 'mitmproxy-ca-cert.pem');
  if (existsSync(caPath)) return caPath;
  if (!mitmdumpBin) return null;

  ok('Generating mitmproxy CA (one-time)…');
  try {
    const proc = spawn(mitmdumpBin, ['--listen-port', '19876'], { detached: true, stdio: 'ignore' });
    await new Promise(r => setTimeout(r, 2500));
    try { process.kill(-proc.pid); } catch {}
    proc.unref();
  } catch {}

  return existsSync(caPath) ? caPath : null;
}

/**
 * Copilot CLI alias routed through Myelin mitmproxy at port 8888.
 * Native auth preserved — HTTPS_PROXY causes Copilot to send its
 * TLS traffic through mitmproxy which intercepts + compresses + retries.
 */
function buildCopilotAlias(_port) {
  const mitm = 8888;
  // Only HTTPS_PROXY — not HTTP_PROXY (avoids npm/npx MCP server installs going through proxy).
  // NO_PROXY excludes npm registry, localhost, and non-LLM hosts so only Copilot API traffic
  // is intercepted.
  return `# _copilot routes LLM traffic through Myelin mitmproxy (token compression).
# copilot still works natively without compression.
alias _copilot='HTTPS_PROXY=http://127.0.0.1:${mitm} NO_PROXY=registry.npmjs.org,*.npmjs.com,*.npmjs.org,localhost,127.0.0.1,*.local copilot'`;
}
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
      yes:             { type: 'boolean', default: false, short: 'y' },
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

  const tools     = await detectAll();
  const { proxy: corpProxy } = detectCorporateProxy();
  const caBundles = detectCaBundles();
  const sslEnv    = buildCorporateSslEnv(caBundles[0]?.path ?? null);

  if (flags.check) { printStateTable(tools, caBundles, corpProxy); process.exit(0); }

  mkdirSync(join(home, '.tokenstack'), { recursive: true });
  const existingCfg = await loadConfig(DEFAULT_CONFIG_PATH);
  let port = existingCfg.proxy.headroom.port;
  if (!(await isPortFree(port))) {
    const alreadyOurs = await import('./tools/headroom.mjs').then(m => m.waitForHeadroom(port, 1500)).catch(() => false);
    if (alreadyOurs) {
      ok(`Headroom already running on port ${port} — keeping`);
    } else {
      warn(`Port ${port} in use. Finding a free port...`);
      port = await findFreePort(port + 1, port + 20);
      ok(`Using port ${port}`);
    }
  }

  if (flags['dry-run']) {
    console.log('\n[dry-run] Would install / configure:');
    console.log('  uv, serena, semble, ast-grep, rtk, mitmproxy');
    if (!flags['no-headroom']) console.log('  headroom-ai[all] from PyPI');
    if (flags.profile === 'proxy') console.log(`  headroom service on port ${port}, mitmproxy service on port 8888`);
    if (claudeCC) console.log('  ~/.claude/settings.json, CLAUDE.md, hooks');
    if (copilot)  console.log('  ~/.copilot/mcp-config.json');
    console.log('  shell profile ANTHROPIC_BASE_URL + HTTPS_PROXY alias for copilot');
    console.log('\n[dry-run] No changes made.\n');
    return;
  }


  step('[1/7] Package manager...');
  await ensureUv();
  ok('uv ready');

  // 2. Code discovery tools
  step('[2/7] Code discovery tools...');
  if (!tools.serena.installed) {
    console.log('  Installing Serena (oraios/serena)...');
    // serena on PyPI is an unrelated AMQP package — must install from GitHub as serena-agent
    execSync('uv tool install "serena-agent @ git+https://github.com/oraios/serena.git"', { stdio: 'inherit' });
    ok('serena installed');
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
    if (os === 'darwin') {
      try { execSync('brew install ast-grep', { stdio: 'inherit' }); ok('ast-grep (brew)'); }
      catch { execSync('cargo install ast-grep --locked', { stdio: 'inherit' }); ok('ast-grep (cargo)'); }
    } else if (os === 'linux') {
      // Try npm package (cross-platform, no cargo needed), then GitHub release, then cargo
      try {
        execSync('npm install -g @ast-grep/cli', { stdio: 'inherit' });
        ok('ast-grep (npm)');
      } catch {
        try { execSync('cargo install ast-grep --locked', { stdio: 'inherit' }); ok('ast-grep (cargo)'); }
        catch { warn('ast-grep install failed — install manually: npm install -g @ast-grep/cli'); }
      }
    } else {
      try { execSync('cargo install ast-grep --locked', { stdio: 'inherit' }); ok('ast-grep (cargo)'); }
      catch { warn('ast-grep install failed — install manually'); }
    }
  } else { skip(`ast-grep (${tools.astgrep.version})`); }

  // 3. Proxy backbone
  step('[3/7] Proxy backbone...');
  if (!flags['no-headroom']) {
    if (!tools.headroom.installed) {
      console.log('  Installing headroom...');
      const venv = join(home, '.tokenstack', 'venv');
      execSync(`uv venv ${venv}`, { stdio: 'pipe' });
      execSync(`uv pip install --python ${venv} 'headroom-ai[all]'`, { stdio: 'inherit' });
      ok('headroom installed (headroom-ai from PyPI)');
    } else { skip(`headroom (${tools.headroom.version})`); }
  }

  // Build combined CA bundle: root CA + intermediate CA extracted from live TLS chain
  // This is required when a corporate SSL interceptor (e.g. NetFree/Hot) uses an intermediate
  // CA that isn't in the system trust store. We extract it from the live connection.
  const combinedCert = await buildCombinedCaCert(caBundles[0]?.path ?? null, home);
  if (combinedCert && combinedCert !== caBundles[0]?.path) {
    // Update sslEnv to point to the combined cert
    Object.keys(sslEnv).forEach(k => { sslEnv[k] = combinedCert; });
    ok(`Combined CA cert built → ${combinedCert}`);
  }

  if (!flags['no-rtk']) {
    if (!tools.rtk.installed) { console.log('  Installing RTK...'); await installRtk(os); }
    else { skip(`rtk (${tools.rtk.version})`); }
  }

  // mitmproxy — install binary + generate CA + append CA to PEM bundles
  const mitmdumpBin = await ensureMitmproxy(os);
  if (mitmdumpBin) {
    await ensureMitmCA(home, mitmdumpBin);
    await installMitmproxyCA(home);
    ok('mitmproxy ready');
  } else {
    warn('mitmproxy not available — Copilot compression disabled');
  }

  // 4. Service
  if (!flags['no-headroom'] && flags.profile === 'proxy') {
    step('[4/7] Background service...');
    const binPath = headroomBinPath();
    const cfg = await loadConfig(DEFAULT_CONFIG_PATH);
    const envVars = { HEADROOM_PORT: String(port), ...sslEnv };
    if (corpProxy) envVars.HTTPS_PROXY = corpProxy;
    envVars.OPENAI_TARGET_API_URL = cfg.proxy.headroom.openai_target_url ?? 'https://api.githubcopilot.com';
    await installService({ headroomBin: binPath, port, envVars,
      logPath: join(home, '.tokenstack', 'headroom.log') });
    ok(`service registered (port ${port})`);
    console.log('  Waiting for proxy...');
    const healthy = await waitForHeadroom(port, 10000);
    healthy ? ok(`proxy healthy on :${port}`) : warn(`no response — run: myelin diagnose`);

    // mitmproxy service on port 8888 — intercepts Copilot TLS for compression
    if (mitmdumpBin) {
      const addonPath = mitmAddonPath(home);
      const mitmCfg = cfg.proxy?.mitm ?? {};
      const mitmPort = mitmCfg.port ?? 8888;
      const mitmEnv = {
        MYELIN_HEADROOM_PORT: String(port),
        ...(mitmCfg.block_bypass    ? { MYELIN_BLOCK_BYPASS:    '1'                      } : {}),
        ...(mitmCfg.block_marker    ? { MYELIN_BLOCK_MARKER:    mitmCfg.block_marker     } : {}),
        ...(mitmCfg.override_proxy  ? { MYELIN_OVERRIDE_PROXY:  mitmCfg.override_proxy   } : {}),
        ...(mitmCfg.vpn_domains_file ? { MYELIN_VPN_DOMAINS_FILE: mitmCfg.vpn_domains_file } : {}),
        ...(mitmCfg.extra_providers ? { MYELIN_EXTRA_PROVIDERS: mitmCfg.extra_providers  } : {}),
        ...sslEnv,
      };
      try {
        await installMitmService({
          mitmdumpBin,
          port: mitmPort,
          addonPath,
          envVars: mitmEnv,
          upstreamProxy: corpProxy || '',
          logPath: join(home, '.tokenstack', 'mitmproxy.log'),
          home,
        });
        ok(`mitmproxy service registered (port ${mitmPort})`);
      } catch (e) {
        warn(`mitmproxy service registration failed: ${e.message}`);
      }
    }
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
      const certLines = Object.entries(sslEnv)
        .map(([k, v]) => `export ${k}=${v}`)
        .join('\n');
      const certBlock = certLines ? `\n${certLines}` : '';
      const copilotAlias = buildCopilotAlias(port);
      // On Linux/mac, ensure ~/.local/bin and ~/.tokenstack/bin are in PATH
      const extraPath = os !== 'windows'
        ? '\nexport PATH="$HOME/.local/bin:$HOME/.tokenstack/bin:$PATH"'
        : '';
      writeFileSync(profilePath,
        existing + `\n# >>> myelin managed >>>\nexport HEADROOM_PORT=${port}\nexport ANTHROPIC_BASE_URL="http://127.0.0.1:\${HEADROOM_PORT}"${certBlock}${extraPath}\nalias myelin="node \${HOME}/tokenstack/bin/tokenstack"\n${copilotAlias}\n# <<< myelin managed <<<\n`, 'utf8');
      ok(`${profilePath} (proxy, alias${certLines ? ', CA bundle env vars' : ''}, PATH, copilot alias)`);
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
  console.log(`  Headroom port: ${port}`);
  console.log(`  Mitmproxy:     8888  (Copilot compression + cache)`);
  console.log(`  Headroom:      ${headroomBinPath()}`);
  console.log(`  Config:        ${DEFAULT_CONFIG_PATH}`);
  if (caBundles.length) console.log(`  Corporate SSL: ${caBundles[0].path}`);
  console.log('\n  \u26a0 Start a new terminal/session for all changes to take effect.');
  console.log('\n  myelin verify          \u2192 health check');
  console.log('  myelin config show     \u2192 view settings');
  console.log('  myelin update --check  \u2192 available updates');
  console.log('\u2500'.repeat(55) + '\n');
  _closeRL();
}

main().catch(e => { _closeRL(); console.error(e); process.exit(1); });
