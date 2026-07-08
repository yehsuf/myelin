#!/usr/bin/env node
/**
 * Myelin — complete installer
 * Flags: --profile proxy|mcp|minimal  --index-tier light|default|full
 *        --no-headroom  --no-rtk  --copilot-only  --claude-only
 *        --with-stacklit  --with-litellm  --check  --dry-run
 */
import { parseArgs } from 'node:util';
import { mkdirSync, existsSync, readFileSync, writeFileSync, copyFileSync, accessSync } from 'node:fs';
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
import { fileURLToPath } from 'node:url';
import { execSync, spawn } from 'node:child_process';

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
  if (os === 'windows') {
    // Documents\WindowsPowerShell is Controlled Folder Access protected on many corp machines.
    // Use APPDATA instead and dot-source it from the real $PROFILE.
    const appData = process.env.APPDATA || join(homedir(), 'AppData', 'Roaming');
    return join(appData, 'Microsoft', 'Windows', 'PowerShell', 'v1.0', 'profile.ps1');
  }
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
  // Skip on Windows — openssl/awk not available; ca-bundle.pem already built by installMitmproxyCA
  if (detectOS() === 'windows') return rootCaPath;
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
  const mitmCert = readFileSync(mitmCaPath, 'utf8');
  const mitmMarker = 'CN=mitmproxy';

  // --- 1. Discover all CA-related paths from environment ---
  const envVars = ['NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'REQUESTS_CA_BUNDLE',
                   'HEADROOM_CA_BUNDLE', 'GIT_SSL_CAINFO', 'CURL_CA_BUNDLE'];
  const discovered = new Map(); // path → { writable, isPemBundle }

  for (const v of envVars) {
    const p = process.env[v];
    if (!p || !existsSync(p) || discovered.has(p)) continue;
    // Check if it's a PEM bundle (multiple certs) vs single cert
    let content = '';
    try { content = readFileSync(p, 'utf8'); } catch { continue; }
    const certCount = (content.match(/-----BEGIN CERTIFICATE-----/g) || []).length;
    if (certCount < 1) continue; // not a PEM file at all
    const isPemBundle = certCount > 1;
    // Check writability by attempting a test write
    let writable = false;
    try { accessSync(p, 2 /* W_OK */); writable = true; } catch {}
    discovered.set(p, { writable, isPemBundle, content });
  }

  // --- 2. Always rebuild our own bundle (fresh system content + mitmproxy CA) ---
  const ourBundle = join(home, '.tokenstack', 'ca-bundle.pem');
  mkdirSync(join(home, '.tokenstack'), { recursive: true });

  // Seed from: read-only discovered files + well-known system paths
  let sysCerts = '';
  const seedPaths = [
    ...[...discovered.entries()].filter(([, v]) => !v.writable).map(([p]) => p),
    '/etc/ssl/certs/ca-certificates.crt',
    '/etc/pki/tls/certs/ca-bundle.crt',
    '/etc/ssl/ca-bundle.pem',
    '/etc/ssl/cert.pem',
  ];
  for (const p of seedPaths) {
    if (existsSync(p)) {
      try { sysCerts += readFileSync(p, 'utf8') + '\n'; } catch {}
    }
  }
  if (!sysCerts && process.platform === 'darwin') {
    try { sysCerts = execSync('security find-certificate -a -p /Library/Keychains/SystemRootCertificates.keychain 2>/dev/null', { shell: true, stdio: 'pipe' }).toString(); } catch {}
  }
  // Strip old mitmproxy CA entry, re-add fresh
  const withoutMitm = sysCerts.replace(/\n?# mitmproxy CA[\s\S]*?-----END CERTIFICATE-----\n?/g, '');
  writeFileSync(ourBundle,
    (withoutMitm || '') + '\n# mitmproxy CA (Myelin Copilot interception)\n' + mitmCert + '\n', 'utf8');
  ok(`ca-bundle.pem rebuilt from system CAs + mitmproxy CA`);
  discovered.set(ourBundle, { writable: true, isPemBundle: true, content: readFileSync(ourBundle, 'utf8') });

  // --- 3. For writable PEM bundles: offer to append mitmproxy CA ---
  for (const [pemPath, { writable, isPemBundle, content }] of discovered) {
    if (!writable || !isPemBundle) continue;
    if (content.includes(mitmMarker)) { skip(`${pemPath} — already trusts mitmproxy CA`); continue; }

    if (interactive) {
      const answer = await promptYN(`Add mitmproxy CA to ${pemPath}? [Y/n]: `);
      if (!answer) { skip(`${pemPath} — skipped`); continue; }
    }
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    try { copyFileSync(pemPath, `${pemPath}.bak.${ts}`); } catch {}
    writeFileSync(pemPath,
      content + '\n# mitmproxy CA (Myelin Copilot interception)\n' + mitmCert + '\n', 'utf8');
    ok(`${pemPath} — added mitmproxy CA`);
  }

  // --- 4. Report read-only bundles (inform user, suggest elevation) ---
  const readOnlyBundles = [...discovered.entries()].filter(([p, v]) => !v.writable && v.isPemBundle && p !== ourBundle);
  for (const [p] of readOnlyBundles) {
    skip(`${p} — read-only, content merged into ca-bundle.pem (to add directly: run installer as admin)`);
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
 * Resolves relative to the myelin repo root so it works on all platforms.
 */
function mitmAddonPath(_home) {
  // Resolve relative to the installer script so it works regardless of clone location.
  return join(fileURLToPath(new URL('.', import.meta.url)), 'mitm', 'copilot_addon.py');
}

/**
 * Write a serena MCP wrapper script that detects the git root from CWD at spawn time.
 * Solves Copilot launching MCP servers from a generic CWD instead of the project dir.
 */
function writeSerenaWrapper(home, serenaBin) {
  const binDir = join(home, '.tokenstack', 'bin');
  mkdirSync(binDir, { recursive: true });
  if (process.platform === 'win32') {
    const ps1 = join(binDir, 'serena-mcp.ps1');
    writeFileSync(ps1, `# Detect git root from CWD and pass to serena
$dir = (Get-Location).Path
while ($dir -ne [System.IO.Path]::GetPathRoot($dir)) {
  if (Test-Path (Join-Path $dir '.git')) { break }
  if (Test-Path (Join-Path $dir '.serena\\project.yml')) { break }
  $dir = Split-Path $dir -Parent
}
& '${serenaBin.replace(/\\/g, '\\\\')}' start-mcp-server --project $dir @args
`, 'utf8');
    const cmd = join(binDir, 'serena-mcp.cmd');
    writeFileSync(cmd, `@echo off\npowershell -ExecutionPolicy Bypass -File "${ps1}" %*\n`, 'utf8');
    return cmd;
  }
  const sh = join(binDir, 'serena-mcp');
  writeFileSync(sh, `#!/bin/sh
dir="$PWD"
while [ "$dir" != "/" ]; do
  [ -d "$dir/.git" ] && break
  [ -f "$dir/.serena/project.yml" ] && break
  dir="$(dirname "$dir")"
done
exec "${serenaBin}" start-mcp-server --project "$dir" "$@"
`, 'utf8');
  try { execSync(`chmod +x "${sh}"`, { stdio: 'pipe' }); } catch {}
  return sh;
}

/**
 * Detect the mitmdump binary path (cross-platform).
 * Checks existence for absolute paths, then tries running --version.
 */
function detectMitmdump(os) {
  const candidates =
    os === 'windows'
      ? [
          join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Python', 'Scripts', 'mitmdump.exe'),
          join(process.env.APPDATA ?? '', 'Python', 'Scripts', 'mitmdump.exe'),
          // pip install --user puts in versioned paths e.g. Python313\Scripts
          ...[...Array(8)].map((_, i) =>
            join(process.env.APPDATA ?? '', 'Python', `Python3${10 + i}`, 'Scripts', 'mitmdump.exe')
          ),
          ...[...Array(8)].map((_, i) =>
            join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Python', `Python3${10 + i}`, 'Scripts', 'mitmdump.exe')
          ),
          join(homedir(), '.local', 'bin', 'mitmdump.exe'),
          'mitmdump',
        ]
      : [
          '/opt/homebrew/bin/mitmdump',
          '/usr/local/bin/mitmdump',
          '/usr/bin/mitmdump',
          join(homedir(), '.local', 'bin', 'mitmdump'),
          join(homedir(), '.local', 'bin', 'mitmdump.exe'),
          'mitmdump',
        ];

  for (const c of candidates) {
    const isAbsolute = c.startsWith('/') || c.includes('\\');
    if (isAbsolute && !existsSync(c)) continue;
    // For absolute paths that exist, skip --version check — just return it
    if (isAbsolute && existsSync(c)) return c;
    try {
      execSync(`"${c}" --version`, { stdio: 'ignore', timeout: 5000 });
      return c;
    } catch { /* not found in PATH */ }
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
  const installCmd = os === 'darwin' ? 'brew install mitmproxy'
                   : os === 'windows' ? 'pip install mitmproxy'
                   : 'pip3 install --user mitmproxy';
  warn(`mitmdump not found after install — install manually: ${installCmd}`);
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
    // Run mitmdump briefly in background; poll for CA file (appears in ~0.5-2s)
    const proc = spawn(mitmdumpBin, ['--listen-port', '19876'], {
      detached: true,
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    proc.unref();
    const pid = proc.pid;
    if (!pid) throw new Error('spawn failed — no PID');

    // Poll up to 15s
    for (let i = 0; i < 30; i++) {
      await new Promise(r => setTimeout(r, 500));
      if (existsSync(caPath)) break;
    }
    try { process.kill(pid, 'SIGTERM'); } catch {}
  } catch (e) {
    warn(`CA generation failed: ${e.message}`);
  }

  if (!existsSync(caPath)) {
    skip(`mitmproxy CA not found — run manually: mitmdump --listen-port 19876 &; sleep 3; kill %1`);
    return null;
  }
  return caPath;
}

/**
 * Copilot CLI alias routed through Myelin mitmproxy at port 8888.
 * Native auth preserved — HTTPS_PROXY causes Copilot to send its
 * TLS traffic through mitmproxy which intercepts + compresses + retries.
 */
function buildCopilotAlias(os) {
  const mitm = 8888;
  // Hosts that must bypass mitmproxy — mTLS client certs can't tunnel through CONNECT proxy:
  // - api.github.com: Copilot auth + auto-update
  // - *.akamai.com, *.corp.akamai.com: internal Akamai tools (Jira/Bitbucket/Confluence via mTLS)
  // - npm registries: MCP server installs
  const NO_PROXY_HOSTS = [
    'api.github.com',
    '*.akamai.com',
    '*.corp.akamai.com',
    '*.akamaized.net',
    'track.akamai.com',
    'git.source.akamai.com',
    'collaborate.akamai.com',
    'registry.npmjs.org',
    '*.npmjs.com',
    '*.npmjs.org',
    'repos.akamai.com',
    'localhost',
    '127.0.0.1',
    '::1',
    '*.local',
  ].join(',');

  if (os === 'windows') {
    return `# _copilot: routes through Myelin mitmproxy with health-check fallback
function global:_copilot {
  $probe = Test-NetConnection -ComputerName 127.0.0.1 -Port ${mitm} -WarningAction SilentlyContinue -InformationLevel Quiet 2>$null
  if ($probe) {
    $env:HTTPS_PROXY = "http://127.0.0.1:${mitm}"
    $env:NO_PROXY = "${NO_PROXY_HOSTS}"
    & copilot @args
    $env:HTTPS_PROXY = $null
    $env:NO_PROXY = $null
  } else {
    Write-Warning "myelin: mitmproxy offline (port ${mitm}) - running uncompressed"
    & copilot @args
  }
}`;
  }
  return `# _copilot routes LLM traffic through Myelin mitmproxy (token compression).
# Falls back to plain copilot with a warning if mitmproxy is offline.
function _copilot() {
  if nc -z 127.0.0.1 ${mitm} 2>/dev/null; then
    HTTPS_PROXY=http://127.0.0.1:${mitm} \\
    NO_PROXY=${NO_PROXY_HOSTS} \\
    copilot "$@"
  else
    echo "⚠  myelin: mitmproxy offline (port ${mitm}) — running uncompressed" >&2
    copilot "$@"
  fi
}`;
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
    execSync('uv tool install --python 3.12 "serena-agent @ git+https://github.com/oraios/serena.git"', { stdio: 'inherit' });
    ok('serena installed');
  } else { skip(`serena (${tools.serena.version})`); }
  // Always ensure bottle<0.13 in serena env — 0.13+ is pyzapp (no .py), breaks webview
  try {
    const serenaEnv = execSync('uv tool dir', { stdio: 'pipe' }).toString().trim();
    const bottlePath = join(serenaEnv, 'serena-agent');
    execSync(`uv pip install --python "${bottlePath}" "bottle<0.13"`, { stdio: 'pipe' });
  } catch {}

  if (!tools.semble.installed) {
    console.log('  Installing Semble...'); uvToolInstall('semble[mcp]');
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
      // Windows: no cargo by default — use npm
      try { execSync('npm install -g @ast-grep/cli', { stdio: 'inherit' }); ok('ast-grep (npm)'); }
      catch { warn('ast-grep install failed — install manually: npm install -g @ast-grep/cli'); }
    }
  } else { skip(`ast-grep (${tools.astgrep.version})`); }

  // 3. Proxy backbone
  step('[3/7] Proxy backbone...');
  if (!flags['no-headroom']) {
    if (!tools.headroom.installed) {
      console.log('  Installing headroom...');
      const venv = join(home, '.tokenstack', 'venv');
      if (!existsSync(join(venv, 'pyvenv.cfg'))) {
        execSync(`uv venv ${venv}`, { stdio: 'pipe' });
      }
      // Single quotes break on Windows cmd — use double quotes or no quotes
      const headroomPkg = os === 'windows' ? '"headroom-ai[all]"' : "'headroom-ai[all]'";
      execSync(`uv pip install --python ${venv} ${headroomPkg}`, { stdio: 'inherit' });
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
    // non-interactive when --yes: auto-append CA to bundle without prompting
    await installMitmproxyCA(home, !flags['yes']);
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
    // Skip re-registration if already healthy (avoids false "no response" on re-run)
    const alreadyHealthy = await waitForHeadroom(port, 1500).catch(() => false);
    if (!alreadyHealthy) {
      await installService({ headroomBin: binPath, port, envVars,
        logPath: join(home, '.tokenstack', 'headroom.log') });
      ok(`service registered (port ${port})`);
      console.log('  Waiting for proxy...');
      const healthy = await waitForHeadroom(port, detectOS() === 'windows' ? 15000 : 10000);
      healthy ? ok(`proxy healthy on :${port}`) : warn(`no response — run: myelin diagnose`);
    } else {
      ok(`service registered (port ${port})`);
      ok(`proxy healthy on :${port}`);
    }

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
  // Resolve tool binary paths at install time — needed for Windows where PATH isn't set when Copilot spawns MCPs
  const toolPaths = {};
  for (const t of ['serena', 'semble', 'uvx']) {
    try {
      const p = execSync(os === 'windows' ? `where.exe ${t}` : `which ${t}`, { stdio: 'pipe' })
        .toString().trim().split('\n')[0].trim();
      toolPaths[t] = p || t;
    } catch { toolPaths[t] = t; }
  }

  // Write serena wrapper that detects git root from CWD at spawn time
  const serenaWrapper = writeSerenaWrapper(home, toolPaths.serena);
  toolPaths.serenaWrapper = serenaWrapper;

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
        serena:    { command: serenaWrapper, args: [] },
        semble:    { command: toolPaths.semble, args: [] },
        'mcp-git': { command: toolPaths.uvx, args: ['mcp-server-git'] },
      },
    }, {});
    ok('~/.claude/settings.json (MCPs + proxy env)');
  }

  // Copilot CLI mcp-config.json
  if (copilot) {
    const mcp = join(home, '.copilot', 'mcp-config.json');
    if (existsSync(mcp)) {
      mergeJsonFile(mcp, { mcpServers: {
        serena:    { type: 'local', command: serenaWrapper, args: [],             env: {}, tools: ['*'] },
        semble:    { type: 'local', command: toolPaths.semble, args: [],          env: {}, tools: ['*'] },
        'mcp-git': { type: 'local', command: toolPaths.uvx, args: ['mcp-server-git'], env: {}, tools: ['*'] },
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
    if (os === 'windows') mkdirSync(join(profilePath, '..'), { recursive: true });
    const existing = existsSync(profilePath) ? readFileSync(profilePath, 'utf8') : '';
    const certLines = Object.entries(sslEnv)
      .map(([k, v]) => `export ${k}=${v}`)
      .join('\n');
    const certBlock = certLines ? `\n${certLines}` : '';
    const copilotAlias = buildCopilotAlias(os);
    const repoRoot = fileURLToPath(new URL('..', import.meta.url));
    const myelinCmd = os === 'windows'
      ? `function global:myelin { node "${repoRoot}src/cli/index.mjs" @args }`
      : `alias myelin="node ${repoRoot}src/cli/index.mjs"`;
    const extraPath = os === 'windows' ? '' : '\nexport PATH="$HOME/.local/bin:$HOME/.tokenstack/bin:$PATH"';

    // On Windows, add key bin dirs to process.env.PATH now so tool invocations work
    if (os === 'windows') {
      const winPaths = [
        join(home, '.local', 'bin'),
        join(home, '.tokenstack', 'bin'),
        join(home, 'AppData', 'Roaming', 'uv', 'bin'),
        join(home, 'AppData', 'Local', 'uv', 'bin'),
        join(home, 'AppData', 'Roaming', 'npm'),
        join(home, 'AppData', 'Roaming', 'Python', 'Scripts'),
        ...[...Array(8)].map((_, i) => join(home, 'AppData', 'Roaming', 'Python', `Python3${10+i}`, 'Scripts')),
        ...[...Array(8)].map((_, i) => join(home, 'AppData', 'Local', 'Programs', 'Python', `Python3${10+i}`, 'Scripts')),
      ];
      for (const p of winPaths) {
        if (!process.env.PATH?.includes(p)) process.env.PATH = p + ';' + process.env.PATH;
      }
      // Also add node.exe's own directory (covers nvm4w, portable node)
      const nodeDir = join(process.execPath, '..');
      if (!process.env.PATH?.includes(nodeDir)) process.env.PATH = nodeDir + ';' + process.env.PATH;
    }
    let block;
    if (os === 'windows') {
      const psEnv = `$env:HEADROOM_PORT = "${port}"\n$env:ANTHROPIC_BASE_URL = "http://127.0.0.1:${port}"`;
      const psCert = Object.entries(sslEnv).map(([k, v]) => `$env:${k} = "${v}"`).join('\n');
      const psPaths = [
        `$env:USERPROFILE\\.local\\bin`,
        `$env:USERPROFILE\\.tokenstack\\bin`,
        `$env:APPDATA\\uv\\bin`,
        `$env:LOCALAPPDATA\\uv\\bin`,
        `$env:APPDATA\\npm`,
      ].map(p => `if ($env:PATH -notlike "*${p}*") { $env:PATH = "${p};$env:PATH" }`).join('\n');
      block = `\n# >>> myelin managed >>>\n${psEnv}\n${psCert}\n${psPaths}\n${myelinCmd}\n${copilotAlias}\n# <<< myelin managed <<<\n`;
    } else {
      block = `\n# >>> myelin managed >>>\nexport HEADROOM_PORT=${port}\nexport ANTHROPIC_BASE_URL="http://127.0.0.1:\${HEADROOM_PORT}"${certBlock}${extraPath}\n${myelinCmd}\n${copilotAlias}\n# <<< myelin managed <<<\n`;
    }
    const updated = existing.includes('myelin managed')
      ? existing.replace(/\n?# >>> myelin managed >>>[\s\S]*?# <<< myelin managed <<<\n?/, block)
      : existing + block;
    if (updated !== existing) {
      writeFileSync(profilePath, updated, 'utf8');
      ok(`${profilePath} (proxy, alias${certLines ? ', CA bundle env vars' : ''}, PATH, copilot alias)`);
      // On Windows: dot-source our AppData profile from the real $PROFILE (Documents)
      // so it auto-loads in new PS windows — Documents write goes through PS itself (allowed)
      if (os === 'windows') {
        try {
          execSync(`powershell -ExecutionPolicy Bypass -Command "` +
            `$p = $PROFILE; ` +
            `if (!(Test-Path $p)) { New-Item -Force -Path $p -ItemType File | Out-Null }; ` +
            `$line = '. \\"${profilePath.replace(/\\/g, '\\\\')}\\""'; ` +
            `$c = Get-Content $p -Raw -ErrorAction SilentlyContinue; ` +
            `if ($c -notlike \\"*myelin*\\") { Add-Content $p $line }"`, { stdio: 'pipe' });
          ok(`$PROFILE — dot-sources myelin profile (auto-loads in new windows)`);
        } catch { /* non-fatal */ }
      }
    } else {
      skip(`${profilePath} already configured`);
    }
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
  console.log('\n  myelin verify          \u2192 health check');
  console.log('  myelin config show     \u2192 view settings');
  console.log('  myelin update --check  \u2192 available updates');
  console.log('\u2500'.repeat(55) + '\n');
  _closeRL();

  // Reload shell profiles in all open terminals
  const { runReload } = await import('./cli/reload.mjs');
  await runReload();
}

main().catch(e => { _closeRL(); console.error(e); process.exit(1); });
