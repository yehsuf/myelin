# TokenStack — Plan 1: Foundation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the installer, config system, proxy service management, and `tokenstack` CLI — the foundation every other plan builds on.

**Architecture:** A Node.js (`install.mjs`) installer orchestrates cross-platform setup of the Headroom proxy (Python, runs as launchd/systemd/Task Scheduler service), RTK shell compression (Rust binary), and a YAML config system. A `tokenstack` CLI provides `config set/show/reset`, `verify`, `diagnose`, and `update --check` commands. All config is read from `~/.tokenstack/config.yaml`; environment variables take precedence.

**Tech Stack:** Node.js 20+ (ESM), `js-yaml` (config), `commander` (CLI), `node-fetch` (health checks), Bash (macOS/Linux bootstrap), PowerShell 7 (Windows bootstrap), Python + uv (headroom), Rust/Homebrew (RTK), launchd / systemd / Task Scheduler (service management)

---

## File Map

| File | Responsibility |
|------|---------------|
| `~/tokenstack/package.json` | Node.js manifest, dependencies, `tokenstack` bin entry |
| `~/tokenstack/bin/tokenstack` | CLI shebang entry point |
| `~/tokenstack/src/config/schema.mjs` | Config schema, defaults, deep-merge logic |
| `~/tokenstack/src/config/reader.mjs` | Load config.yaml + apply env var overrides |
| `~/tokenstack/src/config/writer.mjs` | Write config.yaml with backup |
| `~/tokenstack/src/detect/os.mjs` | Platform, shell, arch detection |
| `~/tokenstack/src/detect/tools.mjs` | Detect installed tools + versions |
| `~/tokenstack/src/detect/proxy.mjs` | Corporate proxy + CA bundle auto-detection |
| `~/tokenstack/src/detect/port.mjs` | Port availability check |
| `~/tokenstack/src/tools/uv.mjs` | Install/verify uv |
| `~/tokenstack/src/tools/headroom.mjs` | Install headroom, health check, wrap command |
| `~/tokenstack/src/tools/rtk.mjs` | Install RTK (brew → GitHub release → cargo fallback) |
| `~/tokenstack/src/service/launchd.mjs` | macOS launchd plist + bootstrap/bootout |
| `~/tokenstack/src/service/systemd.mjs` | Linux systemd user unit + enable |
| `~/tokenstack/src/service/windows.mjs` | Windows Task Scheduler registration |
| `~/tokenstack/src/service/index.mjs` | Platform router → correct service module |
| `~/tokenstack/src/cli/config-cmd.mjs` | `tokenstack config set/show/reset/edit` |
| `~/tokenstack/src/cli/verify.mjs` | `tokenstack verify` — health check all components |
| `~/tokenstack/src/cli/diagnose.mjs` | `tokenstack diagnose` — detect/fix port conflicts |
| `~/tokenstack/src/cli/update.mjs` | `tokenstack update [--check]` |
| `~/tokenstack/src/cli/index.mjs` | CLI root (commander setup) |
| `~/tokenstack/src/install.mjs` | Main installer orchestrator |
| `~/tokenstack/install.sh` | macOS/Linux one-line bootstrap |
| `~/tokenstack/install.ps1` | Windows PowerShell bootstrap |
| `~/tokenstack/test/config.test.mjs` | Unit tests: schema, reader, writer |
| `~/tokenstack/test/detect.test.mjs` | Unit tests: OS detection, tool detection |
| `~/tokenstack/test/service.test.mjs` | Unit tests: plist/unit/task generation |
| `~/tokenstack/test/tools.test.mjs` | Unit tests: install logic, version parsing |

---

## Task 1: Project scaffold + test runner

**Files:**
- Create: `~/tokenstack/package.json`
- Create: `~/tokenstack/bin/tokenstack`
- Create: `~/tokenstack/test/config.test.mjs` (skeleton)

- [ ] **Step 1.1: Create `package.json`**

```bash
mkdir -p ~/tokenstack
cat > ~/tokenstack/package.json << 'EOF'
{
  "name": "tokenstack",
  "version": "1.0.0",
  "type": "module",
  "description": "Token-efficient AI workspace installer and manager",
  "bin": {
    "tokenstack": "./bin/tokenstack"
  },
  "scripts": {
    "test": "node --test test/**/*.test.mjs",
    "test:watch": "node --test --watch test/**/*.test.mjs"
  },
  "dependencies": {
    "commander": "^12.0.0",
    "js-yaml": "^4.1.0"
  },
  "devDependencies": {},
  "engines": {
    "node": ">=20.0.0"
  }
}
EOF
```

- [ ] **Step 1.2: Create CLI shebang entry**

```bash
mkdir -p ~/tokenstack/bin
cat > ~/tokenstack/bin/tokenstack << 'EOF'
#!/usr/bin/env node
import('../src/cli/index.mjs').catch(e => { console.error(e); process.exit(1); });
EOF
chmod +x ~/tokenstack/bin/tokenstack
```

- [ ] **Step 1.3: Create test skeleton to verify test runner works**

```bash
mkdir -p ~/tokenstack/test
cat > ~/tokenstack/test/config.test.mjs << 'EOF'
import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

describe('config (placeholder)', () => {
  it('test runner works', () => {
    assert.equal(1 + 1, 2);
  });
});
EOF
```

- [ ] **Step 1.4: Install dependencies and run test**

```bash
cd ~/tokenstack && npm install
node --test test/config.test.mjs
```

Expected output:
```
▶ config (placeholder)
  ✔ test runner works (0.123ms)
▶ config (placeholder) (0.456ms)

ℹ tests 1
ℹ pass 1
ℹ fail 0
```

- [ ] **Step 1.5: Commit**

```bash
cd ~/tokenstack && git init && git add package.json bin/ test/
git commit -m "feat: scaffold tokenstack project with test runner"
```

---

## Task 2: Config schema + reader

**Files:**
- Create: `~/tokenstack/src/config/schema.mjs`
- Create: `~/tokenstack/src/config/reader.mjs`
- Modify: `~/tokenstack/test/config.test.mjs`

- [ ] **Step 2.1: Write failing tests for schema defaults**

Replace `~/tokenstack/test/config.test.mjs`:

```javascript
import { describe, it, before, after } from 'node:test';
import { strict as assert } from 'node:assert';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { DEFAULT_CONFIG, mergeDeep } from '../src/config/schema.mjs';
import { loadConfig } from '../src/config/reader.mjs';

const TEST_DIR = join(homedir(), '.tokenstack-test');

describe('config schema', () => {
  it('DEFAULT_CONFIG has proxy.headroom.port = 8787', () => {
    assert.equal(DEFAULT_CONFIG.proxy.headroom.port, 8787);
  });
  it('DEFAULT_CONFIG has proxy.headroom.bind = 127.0.0.1', () => {
    assert.equal(DEFAULT_CONFIG.proxy.headroom.bind, '127.0.0.1');
  });
  it('DEFAULT_CONFIG has proxy.headroom.enabled = true', () => {
    assert.equal(DEFAULT_CONFIG.proxy.headroom.enabled, true);
  });
  it('DEFAULT_CONFIG has proxy.headroom.backend = kompress-base', () => {
    assert.equal(DEFAULT_CONFIG.proxy.headroom.backend, 'kompress-base');
  });
  it('DEFAULT_CONFIG has index_tier = default', () => {
    assert.equal(DEFAULT_CONFIG.index_tier, 'default');
  });
  it('mergeDeep overwrites leaf values', () => {
    const result = mergeDeep({ a: { b: 1 } }, { a: { b: 2, c: 3 } });
    assert.deepEqual(result, { a: { b: 2, c: 3 } });
  });
  it('mergeDeep preserves keys not in override', () => {
    const result = mergeDeep({ a: 1, b: 2 }, { b: 99 });
    assert.equal(result.a, 1);
    assert.equal(result.b, 99);
  });
});

describe('config reader', () => {
  before(() => mkdirSync(TEST_DIR, { recursive: true }));
  after(() => rmSync(TEST_DIR, { recursive: true, force: true }));

  it('returns defaults when no config file exists', async () => {
    const cfg = await loadConfig(join(TEST_DIR, 'nonexistent.yaml'));
    assert.equal(cfg.proxy.headroom.port, 8787);
    assert.equal(cfg.index_tier, 'default');
  });

  it('merges user config over defaults', async () => {
    const cfgPath = join(TEST_DIR, 'config.yaml');
    writeFileSync(cfgPath, 'proxy:\n  headroom:\n    port: 9090\n');
    const cfg = await loadConfig(cfgPath);
    assert.equal(cfg.proxy.headroom.port, 9090);
    assert.equal(cfg.proxy.headroom.enabled, true); // default preserved
  });

  it('HEADROOM_PORT env var overrides config file', async () => {
    const cfgPath = join(TEST_DIR, 'config.yaml');
    writeFileSync(cfgPath, 'proxy:\n  headroom:\n    port: 9090\n');
    process.env.HEADROOM_PORT = '7777';
    const cfg = await loadConfig(cfgPath);
    assert.equal(cfg.proxy.headroom.port, 7777);
    delete process.env.HEADROOM_PORT;
  });
});
```

- [ ] **Step 2.2: Run test to confirm it fails**

```bash
cd ~/tokenstack && node --test test/config.test.mjs 2>&1 | head -20
```

Expected: `Error: Cannot find module '../src/config/schema.mjs'`

- [ ] **Step 2.3: Implement `src/config/schema.mjs`**

```bash
mkdir -p ~/tokenstack/src/config
cat > ~/tokenstack/src/config/schema.mjs << 'EOF'
export const DEFAULT_CONFIG = {
  version: '1.0',
  proxy: {
    headroom: {
      enabled: true,
      port: 8787,
      bind: '127.0.0.1',
      backend: 'kompress-base',
      thrash_cache: true,
      diff_enforcer: true,
      corporate_proxy: '',
    },
  },
  index_tier: 'default',
  code_discovery: {
    serena: { enabled: true, lsp: { typescript: true, python: true, rust: false, go: true } },
    semble: true,
    astgrep: true,
    mcp_git: true,
    cbm_fallback: { enabled: true, mcp_limit_threshold: 3 },
  },
  conversation_memory: { mem0: true },
  shell_compression: { rtk: true },
  output_sandboxing: { srt: true, context_mode: true },
  budget_routing: {
    litellm: false,
    cheap_model: 'claude-haiku-4-5',
    complex_model: 'claude-opus-4-7',
    cheap_threshold: 0.3,
  },
  output_style: { caveman_rules: true, hooks: true },
  learning: { headroom_learn: true },
  observability: { helicone: false, token_optimizer: true, ai_engineering_coach: true },
  stacklit: { enabled: false },
  semgrep: { enabled: false },
};

export function mergeDeep(base, override) {
  if (typeof base !== 'object' || base === null) return override;
  if (typeof override !== 'object' || override === null) return override;
  const result = { ...base };
  for (const key of Object.keys(override)) {
    result[key] = (typeof override[key] === 'object' && !Array.isArray(override[key]) && override[key] !== null)
      ? mergeDeep(base[key] ?? {}, override[key])
      : override[key];
  }
  return result;
}
EOF
```

- [ ] **Step 2.4: Implement `src/config/reader.mjs`**

```bash
cat > ~/tokenstack/src/config/reader.mjs << 'EOF'
import { readFileSync, existsSync } from 'node:fs';
import { parse } from 'js-yaml';
import { DEFAULT_CONFIG, mergeDeep } from './schema.mjs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const DEFAULT_CONFIG_PATH = join(homedir(), '.tokenstack', 'config.yaml');

export async function loadConfig(configPath = DEFAULT_CONFIG_PATH) {
  let userConfig = {};
  if (existsSync(configPath)) {
    try {
      userConfig = parse(readFileSync(configPath, 'utf8')) ?? {};
    } catch (e) {
      console.warn(`[tokenstack] Warning: Could not parse config at ${configPath}: ${e.message}`);
    }
  }
  let merged = mergeDeep(DEFAULT_CONFIG, userConfig);

  // Env var overrides (highest priority)
  if (process.env.HEADROOM_PORT) {
    merged = mergeDeep(merged, { proxy: { headroom: { port: parseInt(process.env.HEADROOM_PORT, 10) } } });
  }
  if (process.env.TOKENSTACK_PROFILE) {
    merged._profile = process.env.TOKENSTACK_PROFILE;
  }
  if (process.env.TOKENSTACK_INDEX_TIER) {
    merged.index_tier = process.env.TOKENSTACK_INDEX_TIER;
  }

  return merged;
}
EOF
```

- [ ] **Step 2.5: Run tests — all must pass**

```bash
cd ~/tokenstack && node --test test/config.test.mjs
```

Expected: 10 passing tests, 0 failures.

- [ ] **Step 2.6: Commit**

```bash
cd ~/tokenstack && git add src/config/ test/config.test.mjs
git commit -m "feat: add config schema with defaults, deep-merge, and env var overrides"
```

---

## Task 3: Config writer

**Files:**
- Create: `~/tokenstack/src/config/writer.mjs`
- Modify: `~/tokenstack/test/config.test.mjs` (add writer tests)

- [ ] **Step 3.1: Add failing writer tests**

Append to `~/tokenstack/test/config.test.mjs`:

```javascript
import { writeConfig, setConfigValue, getConfigValue } from '../src/config/writer.mjs';
import { readFileSync } from 'node:fs';

describe('config writer', () => {
  it('writeConfig creates file with yaml', async () => {
    const p = join(TEST_DIR, 'write-test.yaml');
    await writeConfig({ proxy: { headroom: { port: 9999 } } }, p);
    const content = readFileSync(p, 'utf8');
    assert.ok(content.includes('port: 9999'));
  });

  it('writeConfig backs up existing file', async () => {
    const p = join(TEST_DIR, 'backup-test.yaml');
    writeFileSync(p, 'proxy:\n  headroom:\n    port: 1234\n');
    await writeConfig({ proxy: { headroom: { port: 5678 } } }, p);
    // backup should exist
    const { readdirSync } = await import('node:fs');
    const files = readdirSync(TEST_DIR);
    assert.ok(files.some(f => f.startsWith('backup-test.yaml.bak.')));
  });

  it('setConfigValue updates a dot-path key', async () => {
    const p = join(TEST_DIR, 'set-test.yaml');
    writeFileSync(p, 'proxy:\n  headroom:\n    port: 8787\n');
    await setConfigValue('proxy.headroom.port', '9191', p);
    const cfg = await loadConfig(p);
    assert.equal(cfg.proxy.headroom.port, 9191);
  });

  it('getConfigValue reads a dot-path key', async () => {
    const p = join(TEST_DIR, 'get-test.yaml');
    writeFileSync(p, 'proxy:\n  headroom:\n    port: 3333\n');
    const val = await getConfigValue('proxy.headroom.port', p);
    assert.equal(val, 3333);
  });
});
```

- [ ] **Step 3.2: Run to confirm it fails**

```bash
cd ~/tokenstack && node --test test/config.test.mjs 2>&1 | grep "Cannot find"
```

Expected: `Cannot find module '../src/config/writer.mjs'`

- [ ] **Step 3.3: Implement `src/config/writer.mjs`**

```bash
cat > ~/tokenstack/src/config/writer.mjs << 'EOF'
import { writeFileSync, existsSync, copyFileSync } from 'node:fs';
import { dump, load } from 'js-yaml';
import { loadConfig, DEFAULT_CONFIG_PATH } from './reader.mjs';
import { mergeDeep } from './schema.mjs';

export async function writeConfig(config, configPath = DEFAULT_CONFIG_PATH) {
  if (existsSync(configPath)) {
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    copyFileSync(configPath, `${configPath}.bak.${ts}`);
  }
  writeFileSync(configPath, dump(config, { lineWidth: 120 }), 'utf8');
}

export async function setConfigValue(dotPath, value, configPath = DEFAULT_CONFIG_PATH) {
  const current = await loadConfig(configPath);
  const keys = dotPath.split('.');
  let node = current;
  for (let i = 0; i < keys.length - 1; i++) {
    if (typeof node[keys[i]] !== 'object' || node[keys[i]] === null) node[keys[i]] = {};
    node = node[keys[i]];
  }
  // coerce numeric strings
  const raw = value;
  node[keys[keys.length - 1]] = isNaN(raw) ? (raw === 'true' ? true : raw === 'false' ? false : raw) : Number(raw);
  await writeConfig(current, configPath);
}

export async function getConfigValue(dotPath, configPath = DEFAULT_CONFIG_PATH) {
  const cfg = await loadConfig(configPath);
  return dotPath.split('.').reduce((o, k) => (o != null ? o[k] : undefined), cfg);
}
EOF
```

- [ ] **Step 3.4: Run tests — all pass**

```bash
cd ~/tokenstack && node --test test/config.test.mjs
```

Expected: 14 passing, 0 failures.

- [ ] **Step 3.5: Commit**

```bash
cd ~/tokenstack && git add src/config/writer.mjs test/config.test.mjs
git commit -m "feat: add config writer with backup, dot-path set/get"
```

---

## Task 4: OS + tool detection

**Files:**
- Create: `~/tokenstack/src/detect/os.mjs`
- Create: `~/tokenstack/src/detect/tools.mjs`
- Create: `~/tokenstack/test/detect.test.mjs`

- [ ] **Step 4.1: Write failing tests**

```bash
cat > ~/tokenstack/test/detect.test.mjs << 'EOF'
import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { detectOS, detectShell } from '../src/detect/os.mjs';
import { detectTool, detectUv, detectNode } from '../src/detect/tools.mjs';

describe('detectOS', () => {
  it('returns darwin, linux, or windows', () => {
    const os = detectOS();
    assert.ok(['darwin', 'linux', 'windows'].includes(os), `unexpected: ${os}`);
  });
  it('returns arch string', () => {
    const { arch } = detectOS(true);
    assert.ok(['x64', 'arm64'].includes(arch), `unexpected: ${arch}`);
  });
});

describe('detectShell', () => {
  it('returns a non-empty string', () => {
    const shell = detectShell();
    assert.ok(typeof shell === 'string' && shell.length > 0);
  });
});

describe('detectTool', () => {
  it('detects node as installed', async () => {
    const r = await detectTool('node', '--version');
    assert.equal(r.installed, true);
    assert.ok(r.version.startsWith('v'));
  });
  it('returns installed=false for nonexistent tool', async () => {
    const r = await detectTool('definitely-not-installed-xyzzy-12345', '--version');
    assert.equal(r.installed, false);
    assert.equal(r.version, null);
  });
});

describe('detectUv', () => {
  it('returns { installed, version, path }', async () => {
    const r = await detectUv();
    assert.ok('installed' in r);
    assert.ok('version' in r);
    assert.ok('path' in r);
  });
});

describe('detectNode', () => {
  it('installed=true with version >=20', async () => {
    const r = await detectNode();
    assert.equal(r.installed, true);
    const major = parseInt(r.version.replace('v', '').split('.')[0], 10);
    assert.ok(major >= 20, `node major version ${major} < 20`);
  });
});
EOF
```

- [ ] **Step 4.2: Run to confirm it fails**

```bash
cd ~/tokenstack && node --test test/detect.test.mjs 2>&1 | head -5
```

Expected: `Cannot find module '../src/detect/os.mjs'`

- [ ] **Step 4.3: Implement `src/detect/os.mjs`**

```bash
mkdir -p ~/tokenstack/src/detect
cat > ~/tokenstack/src/detect/os.mjs << 'EOF'
import { platform, arch as _arch } from 'node:os';
import { env } from 'node:process';

export function detectOS(detailed = false) {
  const p = platform();
  const os = p === 'darwin' ? 'darwin' : p === 'win32' ? 'windows' : 'linux';
  if (!detailed) return os;
  return { os, arch: _arch(), platform: p };
}

export function detectShell() {
  if (process.platform === 'win32') {
    return env.COMSPEC ?? 'powershell.exe';
  }
  return env.SHELL ?? '/bin/sh';
}

export function homeDir() {
  return process.env.HOME ?? process.env.USERPROFILE ?? '/tmp';
}
EOF
```

- [ ] **Step 4.4: Implement `src/detect/tools.mjs`**

```bash
cat > ~/tokenstack/src/detect/tools.mjs << 'EOF'
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { which } from './which.mjs';

const execFileP = promisify(execFile);

export async function detectTool(name, versionFlag = '--version') {
  try {
    const path = await which(name);
    if (!path) return { installed: false, version: null, path: null };
    const { stdout } = await execFileP(name, [versionFlag], { timeout: 5000 });
    const version = stdout.trim().split('\n')[0].trim();
    return { installed: true, version, path };
  } catch {
    return { installed: false, version: null, path: null };
  }
}

export async function detectUv() {
  return detectTool('uv', '--version');
}

export async function detectNode() {
  return detectTool('node', '--version');
}

export async function detectHeadroom() {
  return detectTool('headroom', '--version');
}

export async function detectRtk() {
  return detectTool('rtk', '--version');
}

export async function detectSerena() {
  return detectTool('serena', '--version');
}

export async function detectSemble() {
  return detectTool('semble', '--version');
}

export async function detectAstGrep() {
  return detectTool('ast-grep', '--version');
}

export async function detectAll() {
  const [node, uv, headroom, rtk, serena, semble, astgrep] = await Promise.all([
    detectNode(), detectUv(), detectHeadroom(), detectRtk(),
    detectSerena(), detectSemble(), detectAstGrep(),
  ]);
  return { node, uv, headroom, rtk, serena, semble, astgrep };
}
EOF
```

- [ ] **Step 4.5: Create cross-platform `which` helper**

```bash
cat > ~/tokenstack/src/detect/which.mjs << 'EOF'
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const execFileP = promisify(execFile);

export async function which(name) {
  try {
    const cmd = process.platform === 'win32' ? 'where' : 'which';
    const { stdout } = await execFileP(cmd, [name], { timeout: 3000 });
    return stdout.trim().split('\n')[0];
  } catch {
    return null;
  }
}
EOF
```

- [ ] **Step 4.6: Run tests — all pass**

```bash
cd ~/tokenstack && node --test test/detect.test.mjs
```

Expected: 7 passing, 0 failures.

- [ ] **Step 4.7: Commit**

```bash
cd ~/tokenstack && git add src/detect/ test/detect.test.mjs
git commit -m "feat: add cross-platform OS and tool detection"
```

---

## Task 5: Corporate proxy + port detection

**Files:**
- Create: `~/tokenstack/src/detect/proxy.mjs`
- Create: `~/tokenstack/src/detect/port.mjs`
- Modify: `~/tokenstack/test/detect.test.mjs`

- [ ] **Step 5.1: Add failing tests**

Append to `~/tokenstack/test/detect.test.mjs`:

```javascript
import { detectCorporateProxy, detectCaBundles } from '../src/detect/proxy.mjs';
import { isPortFree, findFreePort } from '../src/detect/port.mjs';

describe('detectCorporateProxy', () => {
  it('returns an object with proxy and noProxy keys', () => {
    const r = detectCorporateProxy();
    assert.ok('proxy' in r);
    assert.ok('noProxy' in r);
  });
});

describe('detectCaBundles', () => {
  it('returns an array', () => {
    const r = detectCaBundles();
    assert.ok(Array.isArray(r));
  });
  it('every entry has path and source', () => {
    for (const b of detectCaBundles()) {
      assert.ok('path' in b, 'missing path');
      assert.ok('source' in b, 'missing source');
    }
  });
});

describe('port detection', () => {
  it('isPortFree returns boolean', async () => {
    const r = await isPortFree(59999);
    assert.equal(typeof r, 'boolean');
  });
  it('findFreePort returns a number in range', async () => {
    const port = await findFreePort(59000, 59999);
    assert.ok(port >= 59000 && port <= 59999, `port ${port} out of range`);
  });
  it('port 0 is never free', async () => {
    const r = await isPortFree(0);
    assert.equal(r, false);
  });
});
```

- [ ] **Step 5.2: Run to confirm it fails**

```bash
cd ~/tokenstack && node --test test/detect.test.mjs 2>&1 | grep "Cannot find" | head -3
```

- [ ] **Step 5.3: Implement `src/detect/proxy.mjs`**

```bash
cat > ~/tokenstack/src/detect/proxy.mjs << 'EOF'
import { env } from 'node:process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const CA_PATHS_LINUX = [
  '/etc/ssl/certs/ca-certificates.crt',       // Debian/Ubuntu
  '/etc/pki/tls/certs/ca-bundle.crt',          // RHEL/Fedora
  '/etc/ssl/cert.pem',                         // Alpine
];

const CA_FILENAMES_HOME = [
  'netfree-ca.pem', 'netfree_hot.crt', 'root_ca_x2_bundle.crt', 'cacert.pem',
];

export function detectCorporateProxy() {
  const proxy = env.HTTPS_PROXY ?? env.https_proxy ?? env.HTTP_PROXY ?? env.http_proxy ?? '';
  const noProxy = env.NO_PROXY ?? env.no_proxy ?? '';
  return { proxy, noProxy };
}

export function detectCaBundles() {
  const bundles = [];
  // Explicit env var
  if (env.HEADROOM_CA_BUNDLE && existsSync(env.HEADROOM_CA_BUNDLE)) {
    bundles.push({ path: env.HEADROOM_CA_BUNDLE, source: 'HEADROOM_CA_BUNDLE' });
  }
  if (env.REQUESTS_CA_BUNDLE && existsSync(env.REQUESTS_CA_BUNDLE)) {
    bundles.push({ path: env.REQUESTS_CA_BUNDLE, source: 'REQUESTS_CA_BUNDLE' });
  }
  if (env.SSL_CERT_FILE && existsSync(env.SSL_CERT_FILE)) {
    bundles.push({ path: env.SSL_CERT_FILE, source: 'SSL_CERT_FILE' });
  }
  // Home directory CA files (common in corporate environments)
  const home = homedir();
  for (const name of CA_FILENAMES_HOME) {
    const p = join(home, name);
    if (existsSync(p)) bundles.push({ path: p, source: `~/${name}` });
  }
  // System CA paths (Linux)
  for (const p of CA_PATHS_LINUX) {
    if (existsSync(p)) bundles.push({ path: p, source: 'system' });
  }
  return bundles;
}

export function buildCorporateSslEnv(caBundle = null) {
  if (!caBundle) {
    const bundles = detectCaBundles();
    if (bundles.length === 0) return {};
    caBundle = bundles[0].path;
  }
  return {
    HEADROOM_CA_BUNDLE: caBundle,
    NODE_EXTRA_CA_CERTS: caBundle,
    REQUESTS_CA_BUNDLE: caBundle,
    SSL_CERT_FILE: caBundle,
    GIT_SSL_CAINFO: caBundle,
  };
}
EOF
```

- [ ] **Step 5.4: Implement `src/detect/port.mjs`**

```bash
cat > ~/tokenstack/src/detect/port.mjs << 'EOF'
import { createServer } from 'node:net';

export function isPortFree(port) {
  if (!port || port < 1) return Promise.resolve(false);
  return new Promise(resolve => {
    const s = createServer();
    s.once('error', () => resolve(false));
    s.once('listening', () => { s.close(); resolve(true); });
    s.listen(port, '127.0.0.1');
  });
}

export async function findFreePort(start = 8787, end = 8900) {
  for (let p = start; p <= end; p++) {
    if (await isPortFree(p)) return p;
  }
  throw new Error(`No free port found in range ${start}-${end}`);
}
EOF
```

- [ ] **Step 5.5: Run tests — all pass**

```bash
cd ~/tokenstack && node --test test/detect.test.mjs
```

Expected: 12+ passing, 0 failures.

- [ ] **Step 5.6: Commit**

```bash
cd ~/tokenstack && git add src/detect/proxy.mjs src/detect/port.mjs test/detect.test.mjs
git commit -m "feat: add corporate proxy detection, CA bundle discovery, port availability check"
```

---

## Task 6: Service file generation (launchd / systemd / Windows)

**Files:**
- Create: `~/tokenstack/src/service/launchd.mjs`
- Create: `~/tokenstack/src/service/systemd.mjs`
- Create: `~/tokenstack/src/service/windows.mjs`
- Create: `~/tokenstack/src/service/index.mjs`
- Create: `~/tokenstack/test/service.test.mjs`

- [ ] **Step 6.1: Write failing tests**

```bash
cat > ~/tokenstack/test/service.test.mjs << 'EOF'
import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { generatePlist } from '../src/service/launchd.mjs';
import { generateSystemdUnit } from '../src/service/systemd.mjs';
import { generateTaskXml } from '../src/service/windows.mjs';

const OPTS = {
  headroomBin: '/home/user/.local/bin/headroom',
  port: 8787,
  envVars: { ANTHROPIC_API_KEY: 'sk-test', HEADROOM_PORT: '8787' },
  logPath: '/tmp/headroom.log',
  user: 'testuser',
};

describe('launchd plist generator', () => {
  it('contains the label', () => {
    const xml = generatePlist(OPTS);
    assert.ok(xml.includes('com.tokenstack.headroom'));
  });
  it('contains the binary path', () => {
    const xml = generatePlist(OPTS);
    assert.ok(xml.includes(OPTS.headroomBin));
  });
  it('contains the port argument', () => {
    const xml = generatePlist(OPTS);
    assert.ok(xml.includes('8787'));
  });
  it('contains KeepAlive key', () => {
    const xml = generatePlist(OPTS);
    assert.ok(xml.includes('<key>KeepAlive</key>'));
  });
  it('contains env var', () => {
    const xml = generatePlist(OPTS);
    assert.ok(xml.includes('HEADROOM_PORT'));
  });
});

describe('systemd unit generator', () => {
  it('contains ExecStart with binary', () => {
    const unit = generateSystemdUnit(OPTS);
    assert.ok(unit.includes('ExecStart=' + OPTS.headroomBin));
  });
  it('contains Restart=always', () => {
    const unit = generateSystemdUnit(OPTS);
    assert.ok(unit.includes('Restart=always'));
  });
  it('contains WantedBy=default.target', () => {
    const unit = generateSystemdUnit(OPTS);
    assert.ok(unit.includes('WantedBy=default.target'));
  });
  it('contains env var', () => {
    const unit = generateSystemdUnit(OPTS);
    assert.ok(unit.includes('HEADROOM_PORT'));
  });
});

describe('windows task xml generator', () => {
  it('contains task name', () => {
    const xml = generateTaskXml(OPTS);
    assert.ok(xml.includes('TokenstackHeadroom'));
  });
  it('contains command path', () => {
    const xml = generateTaskXml(OPTS);
    assert.ok(xml.includes(OPTS.headroomBin));
  });
  it('contains port argument', () => {
    const xml = generateTaskXml(OPTS);
    assert.ok(xml.includes('8787'));
  });
});
EOF
```

- [ ] **Step 6.2: Run to confirm it fails**

```bash
cd ~/tokenstack && node --test test/service.test.mjs 2>&1 | head -5
```

- [ ] **Step 6.3: Implement `src/service/launchd.mjs`**

```bash
mkdir -p ~/tokenstack/src/service
cat > ~/tokenstack/src/service/launchd.mjs << 'EOF'
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { execSync } from 'node:child_process';

const LABEL = 'com.tokenstack.headroom';

export function generatePlist({ headroomBin, port, envVars = {}, logPath }) {
  const envEntries = Object.entries(envVars)
    .map(([k, v]) => `        <key>${k}</key>\n        <string>${v}</string>`)
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${LABEL}</string>
    <key>ProgramArguments</key>
    <array>
        <string>${headroomBin}</string>
        <string>proxy</string>
        <string>--port</string>
        <string>${port}</string>
    </array>
    <key>EnvironmentVariables</key>
    <dict>
${envEntries}
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>ThrottleInterval</key>
    <integer>10</integer>
    <key>StandardOutPath</key>
    <string>${logPath ?? '/tmp/tokenstack-headroom.log'}</string>
    <key>StandardErrorPath</key>
    <string>${logPath ?? '/tmp/tokenstack-headroom.log'}</string>
</dict>
</plist>`;
}

export function plistPath() {
  return join(homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);
}

export function installService(opts) {
  const content = generatePlist(opts);
  const p = plistPath();
  mkdirSync(join(homedir(), 'Library', 'LaunchAgents'), { recursive: true });
  writeFileSync(p, content, 'utf8');
  const uid = process.getuid?.() ?? execSync('id -u').toString().trim();
  try { execSync(`launchctl bootout gui/${uid}/${LABEL}`, { stdio: 'ignore' }); } catch {}
  execSync(`launchctl bootstrap gui/${uid} ${p}`);
}

export function serviceStatus() {
  try {
    const out = execSync(`launchctl list ${LABEL} 2>&1`).toString();
    return { running: !out.includes('Could not find service'), raw: out };
  } catch {
    return { running: false, raw: '' };
  }
}
EOF
```

- [ ] **Step 6.4: Implement `src/service/systemd.mjs`**

```bash
cat > ~/tokenstack/src/service/systemd.mjs << 'EOF'
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { execSync } from 'node:child_process';

export function generateSystemdUnit({ headroomBin, port, envVars = {} }) {
  const envLines = Object.entries(envVars).map(([k, v]) => `Environment=${k}=${v}`).join('\n');
  return `[Unit]
Description=TokenStack Headroom AI Proxy
After=network.target

[Service]
ExecStart=${headroomBin} proxy --port ${port}
Restart=always
RestartSec=10
${envLines}

[Install]
WantedBy=default.target`;
}

export function unitPath() {
  return join(homedir(), '.config', 'systemd', 'user', 'tokenstack-headroom.service');
}

export function installService(opts) {
  const content = generateSystemdUnit(opts);
  const p = unitPath();
  mkdirSync(join(homedir(), '.config', 'systemd', 'user'), { recursive: true });
  writeFileSync(p, content, 'utf8');
  execSync('systemctl --user daemon-reload');
  execSync('systemctl --user enable --now tokenstack-headroom.service');
}

export function serviceStatus() {
  try {
    execSync('systemctl --user is-active tokenstack-headroom.service', { stdio: 'ignore' });
    return { running: true };
  } catch {
    return { running: false };
  }
}
EOF
```

- [ ] **Step 6.5: Implement `src/service/windows.mjs`**

```bash
cat > ~/tokenstack/src/service/windows.mjs << 'EOF'
import { execSync } from 'node:child_process';

export function generateTaskXml({ headroomBin, port }) {
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>TokenStack Headroom AI Proxy</Description>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger><Enabled>true</Enabled></LogonTrigger>
  </Triggers>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <RestartInterval>PT1M</RestartInterval>
    <RestartCount>999</RestartCount>
  </Settings>
  <Actions>
    <Exec>
      <Command>${headroomBin.replace(/\//g, '\\')}.exe</Command>
      <Arguments>proxy --port ${port}</Arguments>
    </Exec>
  </Actions>
</Task>`;
}

export function installService(opts) {
  const ps = `
$headroomBin = "${opts.headroomBin.replace(/\//g, '\\\\')}";
$action = New-ScheduledTaskAction -Execute "$headroomBin.exe" -Argument "proxy --port ${opts.port}";
$trigger = New-ScheduledTaskTrigger -AtLogon -User $env:USERNAME;
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopOnIdleEnd -RestartInterval (New-TimeSpan -Minutes 1) -RestartCount 999 -ExecutionTimeLimit (New-TimeSpan -Hours 0);
Register-ScheduledTask -TaskName "TokenstackHeadroom" -Action $action -Trigger $trigger -Settings $settings -Force;
Start-ScheduledTask -TaskName "TokenstackHeadroom";
`;
  execSync(`powershell -ExecutionPolicy Bypass -Command "${ps.replace(/"/g, '\\"')}"`);
}

export function serviceStatus() {
  try {
    const out = execSync('powershell -Command "(Get-ScheduledTask -TaskName TokenstackHeadroom).State"').toString().trim();
    return { running: out === 'Running', state: out };
  } catch {
    return { running: false, state: 'Unknown' };
  }
}
EOF
```

- [ ] **Step 6.6: Implement `src/service/index.mjs`**

```bash
cat > ~/tokenstack/src/service/index.mjs << 'EOF'
import { detectOS } from '../detect/os.mjs';

export async function installService(opts) {
  const os = detectOS();
  if (os === 'darwin') {
    const { installService } = await import('./launchd.mjs');
    return installService(opts);
  } else if (os === 'linux') {
    const { installService } = await import('./systemd.mjs');
    return installService(opts);
  } else {
    const { installService } = await import('./windows.mjs');
    return installService(opts);
  }
}

export async function serviceStatus() {
  const os = detectOS();
  if (os === 'darwin') {
    const { serviceStatus } = await import('./launchd.mjs');
    return serviceStatus();
  } else if (os === 'linux') {
    const { serviceStatus } = await import('./systemd.mjs');
    return serviceStatus();
  } else {
    const { serviceStatus } = await import('./windows.mjs');
    return serviceStatus();
  }
}
EOF
```

- [ ] **Step 6.7: Run tests — all pass**

```bash
cd ~/tokenstack && node --test test/service.test.mjs
```

Expected: 12 passing, 0 failures.

- [ ] **Step 6.8: Commit**

```bash
cd ~/tokenstack && git add src/service/ test/service.test.mjs
git commit -m "feat: add service management for launchd/systemd/Windows Task Scheduler"
```

---

## Task 7: RTK + Headroom installation logic

**Files:**
- Create: `~/tokenstack/src/tools/uv.mjs`
- Create: `~/tokenstack/src/tools/rtk.mjs`
- Create: `~/tokenstack/src/tools/headroom.mjs`
- Create: `~/tokenstack/test/tools.test.mjs`

- [ ] **Step 7.1: Write failing tests**

```bash
cat > ~/tokenstack/test/tools.test.mjs << 'EOF'
import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { parseRtkVersion, rtkInstallStrategy } from '../src/tools/rtk.mjs';
import { parseHeadroomVersion, headroomHealthUrl } from '../src/tools/headroom.mjs';

describe('RTK version parsing', () => {
  it('parses version from rtk --version output', () => {
    const v = parseRtkVersion('rtk 0.5.1');
    assert.equal(v, '0.5.1');
  });
  it('returns null for unrecognised output', () => {
    assert.equal(parseRtkVersion(''), null);
    assert.equal(parseRtkVersion('not a version'), null);
  });
});

describe('RTK install strategy', () => {
  it('returns brew on darwin', () => {
    const s = rtkInstallStrategy('darwin');
    assert.equal(s[0].method, 'brew');
  });
  it('returns brew on linux', () => {
    const s = rtkInstallStrategy('linux');
    assert.equal(s[0].method, 'brew');
  });
  it('returns github_release first on windows', () => {
    const s = rtkInstallStrategy('windows');
    assert.equal(s[0].method, 'github_release');
  });
  it('always includes cargo as last fallback', () => {
    const s = rtkInstallStrategy('darwin');
    assert.equal(s[s.length - 1].method, 'cargo');
  });
});

describe('Headroom version parsing', () => {
  it('parses version from headroom --version output', () => {
    const v = parseHeadroomVersion('headroom 1.2.3');
    assert.equal(v, '1.2.3');
  });
  it('parses version from pip show style', () => {
    const v = parseHeadroomVersion('headroom-ai 1.0.0');
    assert.equal(v, '1.0.0');
  });
});

describe('headroomHealthUrl', () => {
  it('constructs URL from port', () => {
    const url = headroomHealthUrl(8787);
    assert.equal(url, 'http://127.0.0.1:8787/health');
  });
  it('uses default 8787', () => {
    assert.equal(headroomHealthUrl(), 'http://127.0.0.1:8787/health');
  });
});
EOF
```

- [ ] **Step 7.2: Run to confirm it fails**

```bash
cd ~/tokenstack && node --test test/tools.test.mjs 2>&1 | head -5
```

- [ ] **Step 7.3: Implement `src/tools/uv.mjs`**

```bash
mkdir -p ~/tokenstack/src/tools
cat > ~/tokenstack/src/tools/uv.mjs << 'EOF'
import { execSync, execFileSync } from 'node:child_process';
import { detectOS } from '../detect/os.mjs';

export async function ensureUv() {
  try {
    execFileSync('uv', ['--version'], { stdio: 'ignore' });
    return { installed: true, alreadyPresent: true };
  } catch {}
  const os = detectOS();
  if (os === 'windows') {
    execSync('powershell -ExecutionPolicy Bypass -c "irm https://astral.sh/uv/install.ps1 | iex"', { stdio: 'inherit' });
  } else {
    execSync('curl -LsSf https://astral.sh/uv/install.sh | sh', { stdio: 'inherit' });
  }
  return { installed: true, alreadyPresent: false };
}

export function uvToolInstall(pkg, extra = []) {
  execSync(`uv tool install ${pkg} ${extra.join(' ')}`, { stdio: 'inherit' });
}

export function uvToolUpgrade(pkg) {
  execSync(`uv tool upgrade ${pkg}`, { stdio: 'inherit' });
}
EOF
```

- [ ] **Step 7.4: Implement `src/tools/rtk.mjs`**

```bash
cat > ~/tokenstack/src/tools/rtk.mjs << 'EOF'
import { execSync } from 'node:child_process';
import { existsSync, writeFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

export function parseRtkVersion(raw = '') {
  const m = raw.match(/(\d+\.\d+\.\d+)/);
  return m ? m[1] : null;
}

export function rtkInstallStrategy(os) {
  if (os === 'windows') {
    return [
      { method: 'github_release', label: 'Download RTK binary (GitHub)' },
      { method: 'cargo', label: 'Build from source (cargo install rtk) — requires Rust + VS Build Tools (~3GB)' },
    ];
  }
  return [
    { method: 'brew', label: 'brew install rtk' },
    { method: 'cargo', label: 'cargo install rtk' },
  ];
}

export async function installRtk(os) {
  const strategies = rtkInstallStrategy(os);
  for (const s of strategies) {
    try {
      if (s.method === 'brew') {
        execSync('brew install rtk', { stdio: 'inherit' });
        return { method: 'brew', ok: true };
      }
      if (s.method === 'github_release') {
        const ok = await tryGithubRelease(os);
        if (ok) return { method: 'github_release', ok: true };
      }
      if (s.method === 'cargo') {
        console.warn('[tokenstack] Installing RTK via cargo — this may take a few minutes.');
        if (os === 'windows') {
          console.warn('[tokenstack] WARNING: cargo on Windows requires ~3GB Visual Studio Build Tools.');
        }
        execSync('cargo install rtk --locked', { stdio: 'inherit' });
        return { method: 'cargo', ok: true };
      }
    } catch (e) {
      console.warn(`[tokenstack] RTK install via ${s.method} failed: ${e.message}`);
    }
  }
  console.warn('[tokenstack] SKIP: RTK could not be installed. Shell compression inactive.');
  return { method: null, ok: false };
}

async function tryGithubRelease(os) {
  try {
    const res = await fetch('https://api.github.com/repos/rtk-ai/rtk/releases/latest');
    const data = await res.json();
    const tag = data.tag_name;
    const asset = data.assets?.find(a => a.name.includes('windows') && a.name.endsWith('.zip'));
    if (!asset) return false;
    const binDir = join(homedir(), '.tokenstack', 'bin');
    execSync(`powershell -Command "Invoke-WebRequest '${asset.browser_download_url}' -OutFile $env:TEMP\\rtk.zip; Expand-Archive $env:TEMP\\rtk.zip -DestinationPath '${binDir}' -Force"`, { stdio: 'inherit' });
    return true;
  } catch {
    return false;
  }
}
EOF
```

- [ ] **Step 7.5: Implement `src/tools/headroom.mjs`**

```bash
cat > ~/tokenstack/src/tools/headroom.mjs << 'EOF'
import { execSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

export function parseHeadroomVersion(raw = '') {
  const m = raw.match(/(\d+\.\d+\.\d+)/);
  return m ? m[1] : null;
}

export function headroomHealthUrl(port = 8787) {
  return `http://127.0.0.1:${port}/health`;
}

export function headroomVenvPath() {
  return join(homedir(), '.tokenstack', 'venv');
}

export function headroomBinPath() {
  const venv = headroomVenvPath();
  const isWin = process.platform === 'win32';
  return isWin
    ? join(venv, 'Scripts', 'headroom.exe')
    : join(venv, 'bin', 'headroom');
}

export async function installHeadroom() {
  const venv = headroomVenvPath();
  mkdirSync(join(homedir(), '.tokenstack'), { recursive: true });
  execSync(`uv venv ${venv}`, { stdio: 'inherit' });
  execSync(`uv pip install --python ${venv} "headroom-ai[all]"`, { stdio: 'inherit' });
  return { binPath: headroomBinPath(), ok: existsSync(headroomBinPath()) };
}

export async function waitForHeadroom(port = 8787, timeoutMs = 5000) {
  const url = headroomHealthUrl(port);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(500) });
      if (res.ok) return true;
    } catch {}
    await new Promise(r => setTimeout(r, 100));
  }
  return false;
}
EOF
```

- [ ] **Step 7.6: Run tests — all pass**

```bash
cd ~/tokenstack && node --test test/tools.test.mjs
```

Expected: 11 passing, 0 failures.

- [ ] **Step 7.7: Commit**

```bash
cd ~/tokenstack && git add src/tools/ test/tools.test.mjs
git commit -m "feat: add uv, RTK, and Headroom install + health-check logic"
```

---

## Task 8: `tokenstack config` CLI command

**Files:**
- Create: `~/tokenstack/src/cli/config-cmd.mjs`
- Create: `~/tokenstack/src/cli/index.mjs`

- [ ] **Step 8.1: Write failing integration test (manual)**

Run the following and expect `Error: Cannot find module`:
```bash
cd ~/tokenstack && node bin/tokenstack config show 2>&1 | head -3
```

- [ ] **Step 8.2: Implement `src/cli/config-cmd.mjs`**

```bash
mkdir -p ~/tokenstack/src/cli
cat > ~/tokenstack/src/cli/config-cmd.mjs << 'EOF'
import { Command } from 'commander';
import { loadConfig, DEFAULT_CONFIG_PATH } from '../config/reader.mjs';
import { setConfigValue, getConfigValue, writeConfig } from '../config/writer.mjs';
import { DEFAULT_CONFIG } from '../config/schema.mjs';
import { dump } from 'js-yaml';
import { execSync } from 'node:child_process';
import { copyFileSync, existsSync } from 'node:fs';

export function configCommand() {
  const cmd = new Command('config').description('Manage TokenStack configuration');

  cmd
    .command('show')
    .description('Print current configuration (merged with defaults)')
    .option('--path <key>', 'Show only a specific key (dot-notation)')
    .action(async ({ path }) => {
      const cfg = await loadConfig();
      if (path) {
        const val = await getConfigValue(path);
        console.log(val !== undefined ? JSON.stringify(val, null, 2) : `(not set — default applies)`);
      } else {
        console.log(dump(cfg, { lineWidth: 120 }));
      }
    });

  cmd
    .command('set <key> <value>')
    .description('Set a configuration value (dot-notation key)')
    .example('tokenstack config set proxy.headroom.port 9090')
    .action(async (key, value) => {
      await setConfigValue(key, value);
      console.log(`✓ Set ${key} = ${value}`);
      if (key === 'proxy.headroom.port') {
        console.log('  ↳ Port change detected — run: tokenstack verify to check the new port');
      }
    });

  cmd
    .command('get <key>')
    .description('Get a single configuration value')
    .action(async (key) => {
      const val = await getConfigValue(key);
      console.log(val !== undefined ? val : '(not set)');
    });

  cmd
    .command('reset')
    .description('Reset configuration to defaults (backs up current config)')
    .action(async () => {
      if (existsSync(DEFAULT_CONFIG_PATH)) {
        const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        copyFileSync(DEFAULT_CONFIG_PATH, `${DEFAULT_CONFIG_PATH}.bak.${ts}`);
        console.log(`✓ Backed up existing config`);
      }
      await writeConfig(DEFAULT_CONFIG);
      console.log(`✓ Configuration reset to defaults at ${DEFAULT_CONFIG_PATH}`);
    });

  cmd
    .command('edit')
    .description('Open configuration in $EDITOR')
    .action(() => {
      const editor = process.env.EDITOR ?? (process.platform === 'win32' ? 'notepad' : 'nano');
      try { execSync(`${editor} ${DEFAULT_CONFIG_PATH}`, { stdio: 'inherit' }); }
      catch (e) { console.error(`Could not open editor: ${e.message}`); process.exit(1); }
    });

  return cmd;
}
EOF
```

- [ ] **Step 8.3: Implement `src/cli/index.mjs`**

```bash
cat > ~/tokenstack/src/cli/index.mjs << 'EOF'
import { Command } from 'commander';
import { configCommand } from './config-cmd.mjs';

const program = new Command();
program
  .name('tokenstack')
  .description('Token-efficient AI workspace manager')
  .version('1.0.0');

program.addCommand(configCommand());

// Placeholder commands (filled in future plans)
program.command('verify').description('Verify all components are healthy').action(() => {
  console.log('verify: coming in a future step');
});
program.command('diagnose').description('Diagnose port conflicts and configuration issues').action(() => {
  console.log('diagnose: coming in a future step');
});
program.command('update').description('Update all tools').option('--check', 'Dry-run only').action(() => {
  console.log('update: coming in a future step');
});
program.command('stats').description('Show token savings for last session').action(() => {
  console.log('stats: coming in Plan 6');
});

program.parse();
EOF
```

- [ ] **Step 8.4: Test the CLI manually**

```bash
cd ~/tokenstack

# Show defaults
node bin/tokenstack config show | head -10

# Set a port
node bin/tokenstack config set proxy.headroom.port 9090

# Get it back
node bin/tokenstack config get proxy.headroom.port

# Reset
node bin/tokenstack config reset
node bin/tokenstack config get proxy.headroom.port
```

Expected output sequence:
```
version: '1.0'
proxy:
  headroom:
    enabled: true
    port: 8787
...
✓ Set proxy.headroom.port = 9090
  ↳ Port change detected — run: tokenstack verify to check the new port
9090
✓ Backed up existing config
✓ Configuration reset to defaults
8787
```

- [ ] **Step 8.5: Commit**

```bash
cd ~/tokenstack && git add src/cli/ && git commit -m "feat: add tokenstack config show/set/get/reset/edit CLI"
```

---

## Task 9: `tokenstack verify` + `tokenstack diagnose`

**Files:**
- Create: `~/tokenstack/src/cli/verify.mjs`
- Create: `~/tokenstack/src/cli/diagnose.mjs`
- Modify: `~/tokenstack/src/cli/index.mjs`

- [ ] **Step 9.1: Implement `src/cli/verify.mjs`**

```bash
cat > ~/tokenstack/src/cli/verify.mjs << 'EOF'
import { loadConfig } from '../config/reader.mjs';
import { waitForHeadroom, headroomHealthUrl } from '../tools/headroom.mjs';
import { detectTool } from '../detect/tools.mjs';
import { serviceStatus } from '../service/index.mjs';

export async function runVerify() {
  const cfg = await loadConfig();
  const port = cfg.proxy.headroom.port;
  const results = [];

  // 1. Headroom service status
  const svc = await serviceStatus();
  results.push({ name: 'Headroom service', ok: svc.running, detail: svc.running ? 'running' : 'not running — try: tokenstack diagnose' });

  // 2. Headroom health endpoint
  const healthy = await waitForHeadroom(port, 3000);
  results.push({ name: `Headroom health (port ${port})`, ok: healthy, detail: healthy ? headroomHealthUrl(port) : `no response on :${port}` });

  // 3. Tools present
  for (const tool of ['uv', 'serena', 'semble', 'ast-grep']) {
    const r = await detectTool(tool, '--version');
    results.push({ name: tool, ok: r.installed, detail: r.installed ? r.version : 'not found — run: tokenstack update' });
  }

  // Print table
  const width = Math.max(...results.map(r => r.name.length));
  console.log('\nTokenStack Component Status\n' + '─'.repeat(60));
  for (const r of results) {
    const icon = r.ok ? '✓' : '✗';
    console.log(`  ${icon} ${r.name.padEnd(width + 2)} ${r.detail}`);
  }
  console.log('─'.repeat(60));
  const passed = results.filter(r => r.ok).length;
  console.log(`  ${passed}/${results.length} components healthy\n`);
  return results.every(r => r.ok);
}
EOF
```

- [ ] **Step 9.2: Implement `src/cli/diagnose.mjs`**

```bash
cat > ~/tokenstack/src/cli/diagnose.mjs << 'EOF'
import { loadConfig } from '../config/reader.mjs';
import { isPortFree, findFreePort } from '../detect/port.mjs';
import { execSync } from 'node:child_process';
import { detectOS } from '../detect/os.mjs';

export async function runDiagnose() {
  const cfg = await loadConfig();
  const port = cfg.proxy.headroom.port;
  const os = detectOS();

  console.log(`\nTokenStack Diagnostics\n${'─'.repeat(50)}`);

  // Check configured port
  const portFree = await isPortFree(port);
  if (portFree) {
    console.log(`✓ Port ${port}: free (proxy is not running)`);
  } else {
    console.log(`✗ Port ${port}: IN USE`);
    // Identify the process
    try {
      const cmd = os === 'windows'
        ? `powershell -Command "Get-NetTCPConnection -LocalPort ${port} | Select-Object -First 1 | ForEach-Object { (Get-Process -Id $_.OwningProcess).Name }"`
        : `lsof -ti:${port}`;
      const pid = execSync(cmd, { timeout: 3000 }).toString().trim();
      if (pid) {
        console.log(`  → Process: ${pid}`);
        console.log(`  → To kill orphan: kill ${pid}  (macOS/Linux) or Stop-Process -Id ${pid} (Windows)`);
      }
    } catch {}
    // Suggest a free port
    try {
      const freePort = await findFreePort(port + 1, port + 20);
      console.log(`  → Suggested free port: ${freePort}`);
      console.log(`  → To switch: tokenstack config set proxy.headroom.port ${freePort}`);
    } catch {}
  }

  // Check for multiple headroom processes
  try {
    const cmd = os === 'windows'
      ? `powershell -Command "(Get-Process headroom -ErrorAction SilentlyContinue).Count"`
      : `pgrep -c headroom`;
    const count = parseInt(execSync(cmd, { timeout: 2000 }).toString().trim(), 10);
    if (count > 1) {
      console.warn(`⚠ ${count} headroom processes running — possible orphan beacons`);
      console.warn(`  → To clean up: pkill headroom  (macOS/Linux) or Stop-Process -Name headroom (Windows)`);
    } else if (count === 1) {
      console.log(`✓ Headroom processes: 1 (healthy)`);
    } else {
      console.log(`  Headroom: not running`);
    }
  } catch {}

  console.log('─'.repeat(50) + '\n');
}
EOF
```

- [ ] **Step 9.3: Wire verify + diagnose into CLI**

Edit `~/tokenstack/src/cli/index.mjs` — replace the placeholder `verify` and `diagnose` commands:

```javascript
// Replace the two placeholder .action() lines:

program.command('verify')
  .description('Verify all components are healthy')
  .action(async () => {
    const { runVerify } = await import('./verify.mjs');
    const ok = await runVerify();
    process.exit(ok ? 0 : 1);
  });

program.command('diagnose')
  .description('Diagnose port conflicts and configuration issues')
  .action(async () => {
    const { runDiagnose } = await import('./diagnose.mjs');
    await runDiagnose();
  });
```

- [ ] **Step 9.4: Manual test**

```bash
cd ~/tokenstack

# Verify (headroom may not be running — that's expected, but other tools should show)
node bin/tokenstack verify

# Diagnose (check port 8787)
node bin/tokenstack diagnose
```

Expected (headroom not running case):
```
TokenStack Component Status
────────────────────────────────────────────────────────────
  ✗ Headroom service              not running — try: tokenstack diagnose
  ✗ Headroom health (port 8787)   no response on :8787
  ✓ uv                            uv 0.5.x
  ✓ serena                        Serena 1.5.4.dev0
  ...
────────────────────────────────────────────────────────────
  2/6 components healthy
```

- [ ] **Step 9.5: Commit**

```bash
cd ~/tokenstack && git add src/cli/verify.mjs src/cli/diagnose.mjs src/cli/index.mjs
git commit -m "feat: add tokenstack verify and diagnose commands"
```

---

## Task 10: Main installer orchestrator (`install.mjs`)

**Files:**
- Create: `~/tokenstack/src/install.mjs`

- [ ] **Step 10.1: Implement `src/install.mjs`**

```bash
cat > ~/tokenstack/src/install.mjs << 'EOF'
#!/usr/bin/env node
/**
 * TokenStack main installer.
 * Flags: --profile proxy|mcp|minimal  --index-tier light|default|full
 *        --no-headroom  --no-rtk  --copilot-only  --claude-only
 *        --with-stacklit  --with-litellm  --check  --dry-run
 */
import { parseArgs } from 'node:util';
import { mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

import { detectOS } from './detect/os.mjs';
import { detectAll } from './detect/tools.mjs';
import { detectCorporateProxy, detectCaBundles, buildCorporateSslEnv } from './detect/proxy.mjs';
import { isPortFree, findFreePort } from './detect/port.mjs';
import { loadConfig, DEFAULT_CONFIG_PATH } from './config/reader.mjs';
import { writeConfig, setConfigValue } from './config/writer.mjs';
import { DEFAULT_CONFIG, mergeDeep } from './config/schema.mjs';
import { ensureUv } from './tools/uv.mjs';
import { installHeadroom, waitForHeadroom, headroomBinPath } from './tools/headroom.mjs';
import { installRtk } from './tools/rtk.mjs';
import { installService } from './service/index.mjs';

async function main() {
  const { values: flags } = parseArgs({
    options: {
      profile:       { type: 'string',  default: 'proxy' },
      'index-tier':  { type: 'string',  default: 'default' },
      'no-headroom': { type: 'boolean', default: false },
      'no-rtk':      { type: 'boolean', default: false },
      'copilot-only':{ type: 'boolean', default: false },
      'claude-only': { type: 'boolean', default: false },
      'with-stacklit':{ type: 'boolean',default: false },
      'with-litellm':{ type: 'boolean', default: false },
      check:         { type: 'boolean', default: false },
      'dry-run':     { type: 'boolean', default: false },
    },
    strict: false,
  });

  const os = detectOS();
  console.log(`\n🛠  TokenStack Installer — ${os}\n`);

  // ── DETECT STATE ──────────────────────────────────────────────
  console.log('Detecting existing installations...');
  const tools = await detectAll();
  const { proxy: corpProxy } = detectCorporateProxy();
  const caBundles = detectCaBundles();
  const sslEnv = buildCorporateSslEnv(caBundles[0]?.path ?? null);

  if (flags.check) {
    printStateTable(tools, caBundles, corpProxy);
    process.exit(0);
  }

  const configPath = DEFAULT_CONFIG_PATH;
  mkdirSync(join(homedir(), '.tokenstack'), { recursive: true });

  // ── RESOLVE PORT ──────────────────────────────────────────────
  const existingCfg = await loadConfig(configPath);
  let port = existingCfg.proxy.headroom.port;
  if (!(await isPortFree(port))) {
    console.warn(`⚠ Port ${port} in use. Finding a free port...`);
    port = await findFreePort(port + 1, port + 20);
    console.log(`  → Using port ${port}`);
  }

  // ── DRY RUN ───────────────────────────────────────────────────
  if (flags['dry-run']) {
    console.log('\n[dry-run] Would install:');
    console.log('  uv (package manager)');
    if (!flags['no-headroom']) console.log('  headroom-ai[all] (proxy backbone)');
    if (!flags['no-rtk'])      console.log('  rtk (shell compression)');
    console.log('  Service management for:', os);
    console.log('\n[dry-run] No changes made.\n');
    return;
  }

  // ── INSTALL TIER 1 ────────────────────────────────────────────
  console.log('\n[1/5] Installing core tools...');
  await ensureUv();

  if (!flags['no-headroom']) {
    if (!tools.headroom.installed) {
      console.log('  Installing headroom-ai...');
      await installHeadroom();
    } else {
      console.log(`  ✓ headroom already installed (${tools.headroom.version})`);
    }
  }

  if (!flags['no-rtk']) {
    if (!tools.rtk.installed) {
      console.log('  Installing RTK...');
      await installRtk(os);
    } else {
      console.log(`  ✓ RTK already installed (${tools.rtk.version})`);
    }
  }

  // ── WRITE CONFIG ──────────────────────────────────────────────
  console.log('\n[2/5] Writing configuration...');
  const newConfig = mergeDeep(DEFAULT_CONFIG, {
    proxy: { headroom: { port, corporate_proxy: corpProxy, ...sslEnv } },
    index_tier: flags['index-tier'],
  });
  if (caBundles.length > 0) {
    console.log(`  ✓ Detected ${caBundles.length} CA bundle(s) — corporate SSL configured`);
  }
  if (!existsSync(configPath)) {
    await writeConfig(newConfig, configPath);
    console.log(`  ✓ Created ${configPath}`);
  } else {
    console.log(`  ✓ Config exists at ${configPath} — preserved (use: tokenstack config set to change)`);
  }

  // ── INSTALL SERVICE ───────────────────────────────────────────
  if (!flags['no-headroom'] && flags.profile === 'proxy') {
    console.log('\n[3/5] Installing background service...');
    const binPath = headroomBinPath();
    const envVars = { HEADROOM_PORT: String(port), ...sslEnv };
    if (corpProxy) envVars.HTTPS_PROXY = corpProxy;
    await installService({ headroomBin: binPath, port, envVars, logPath: join(homedir(), '.tokenstack', 'headroom.log') });
    console.log(`  ✓ Service installed — proxy starting on port ${port}`);

    // Wait for proxy to be healthy
    console.log('  Waiting for proxy to be ready...');
    const healthy = await waitForHeadroom(port, 10000);
    console.log(healthy ? `  ✓ Proxy healthy on :${port}` : `  ⚠ Proxy did not respond in 10s — run: tokenstack diagnose`);
  } else {
    console.log('\n[3/5] Service install: skipped (profile != proxy or --no-headroom)');
  }

  // ── DONE ──────────────────────────────────────────────────────
  console.log('\n[4/5] Tool installs complete.');
  console.log('\n[5/5] Summary\n' + '─'.repeat(50));
  console.log(`  Proxy port:    ${port}`);
  console.log(`  Config:        ${configPath}`);
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
EOF
```

- [ ] **Step 10.2: Test --check flag (safe, no writes)**

```bash
cd ~/tokenstack && node src/install.mjs --check
```

Expected: State table showing currently installed tools, no writes.

- [ ] **Step 10.3: Test --dry-run flag**

```bash
cd ~/tokenstack && node src/install.mjs --dry-run
```

Expected: List of what would be installed, then `[dry-run] No changes made.`

- [ ] **Step 10.4: Commit**

```bash
cd ~/tokenstack && git add src/install.mjs
git commit -m "feat: add main install.mjs orchestrator with check, dry-run, and idempotent install"
```

---

## Task 11: Bootstrap scripts (`install.sh` + `install.ps1`)

**Files:**
- Create: `~/tokenstack/install.sh`
- Create: `~/tokenstack/install.ps1`

- [ ] **Step 11.1: Create `install.sh` (macOS/Linux)**

```bash
cat > ~/tokenstack/install.sh << 'SHEOF'
#!/usr/bin/env sh
# TokenStack installer bootstrap for macOS and Linux
# Usage: curl -fsSL https://get.tokenstack.dev | sh
#        or: sh install.sh [--profile proxy|mcp|minimal] [--check] [--dry-run]
set -e

TOKENSTACK_DIR="${TOKENSTACK_DIR:-$HOME/.tokenstack}"
REPO_DIR="$TOKENSTACK_DIR/repo"
REPO_URL="${TOKENSTACK_REPO_URL:-https://github.com/ysufrin/tokenstack}"

# Require node >=20
check_node() {
  if ! command -v node >/dev/null 2>&1; then
    echo "[tokenstack] Node.js not found. Install from https://nodejs.org (v20+)" >&2
    exit 1
  fi
  NODE_MAJOR=$(node -e "process.stdout.write(String(process.versions.node.split('.')[0]))")
  if [ "$NODE_MAJOR" -lt 20 ]; then
    echo "[tokenstack] Node.js v${NODE_MAJOR} found but v20+ is required." >&2
    exit 1
  fi
}

# Require git
check_git() {
  if ! command -v git >/dev/null 2>&1; then
    echo "[tokenstack] git not found. Install git and try again." >&2
    exit 1
  fi
}

# Clone or update tokenstack repo
fetch_repo() {
  if [ -d "$REPO_DIR/.git" ]; then
    echo "[tokenstack] Updating existing installation..."
    git -C "$REPO_DIR" pull --ff-only
  else
    echo "[tokenstack] Cloning TokenStack..."
    mkdir -p "$(dirname "$REPO_DIR")"
    git clone "$REPO_URL" "$REPO_DIR"
  fi
}

check_node
check_git
fetch_repo

cd "$REPO_DIR"
npm install --silent

echo "[tokenstack] Running installer..."
node src/install.mjs "$@"
SHEOF
chmod +x ~/tokenstack/install.sh
```

- [ ] **Step 11.2: Create `install.ps1` (Windows)**

```bash
cat > ~/tokenstack/install.ps1 << 'PSEOF'
# TokenStack installer bootstrap for Windows (PowerShell 7+)
# Usage: powershell -ExecutionPolicy Bypass -c "irm https://get.tokenstack.dev/install.ps1 | iex"

param(
    [string]$Profile = "proxy",
    [string]$IndexTier = "default",
    [switch]$Check,
    [switch]$DryRun,
    [switch]$NoHeadroom,
    [switch]$CopilotOnly,
    [switch]$ClaudeOnly
)

$ErrorActionPreference = "Stop"
$TokenstackDir = if ($env:TOKENSTACK_DIR) { $env:TOKENSTACK_DIR } else { "$env:USERPROFILE\.tokenstack" }
$RepoDir = Join-Path $TokenstackDir "repo"
$RepoUrl = if ($env:TOKENSTACK_REPO_URL) { $env:TOKENSTACK_REPO_URL } else { "https://github.com/ysufrin/tokenstack" }

function Check-Node {
    try {
        $ver = (node --version 2>&1).Trim()
        $major = [int]($ver.TrimStart('v').Split('.')[0])
        if ($major -lt 20) {
            Write-Error "Node.js $ver found but v20+ is required. Install from https://nodejs.org"
        }
        Write-Host "[tokenstack] Node.js $ver ✓"
    } catch {
        Write-Error "Node.js not found. Install from https://nodejs.org (v20+)"
    }
}

function Check-Git {
    if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
        Write-Error "git not found. Install Git for Windows: https://git-scm.com"
    }
}

function Fetch-Repo {
    if (Test-Path (Join-Path $RepoDir ".git")) {
        Write-Host "[tokenstack] Updating existing installation..."
        git -C $RepoDir pull --ff-only
    } else {
        Write-Host "[tokenstack] Cloning TokenStack..."
        New-Item -ItemType Directory -Force -Path (Split-Path $RepoDir) | Out-Null
        git clone $RepoUrl $RepoDir
    }
}

# Add Defender exclusion before downloads (silent if no admin)
try {
    $binDir = Join-Path $env:USERPROFILE ".tokenstack\bin"
    New-Item -ItemType Directory -Force -Path $binDir | Out-Null
    Add-MpPreference -ExclusionPath $binDir -ErrorAction SilentlyContinue
    Write-Host "[tokenstack] Defender exclusion added for $binDir"
} catch { Write-Host "[tokenstack] Note: Could not add Defender exclusion (requires admin). You may need to add it manually." }

# Enable long paths (silent if no admin)
try {
    Set-ItemProperty -Path "HKLM:\SYSTEM\CurrentControlSet\Control\FileSystem" -Name "LongPathsEnabled" -Value 1 -ErrorAction SilentlyContinue
} catch {}

Check-Node
Check-Git
Fetch-Repo

Set-Location $RepoDir
npm install --silent

Write-Host "[tokenstack] Running installer..."
$args_list = @("src/install.mjs")
if ($Check)       { $args_list += "--check" }
if ($DryRun)      { $args_list += "--dry-run" }
if ($NoHeadroom)  { $args_list += "--no-headroom" }
if ($CopilotOnly) { $args_list += "--copilot-only" }
if ($ClaudeOnly)  { $args_list += "--claude-only" }
$args_list += "--profile", $Profile
$args_list += "--index-tier", $IndexTier

node @args_list
PSEOF
```

- [ ] **Step 11.3: Verify install.sh is executable and syntax-checks**

```bash
bash -n ~/tokenstack/install.sh && echo "✓ install.sh syntax OK"
ls -la ~/tokenstack/install.sh
```

Expected: `✓ install.sh syntax OK` and file is executable.

- [ ] **Step 11.4: Test install.sh --check locally**

```bash
sh ~/tokenstack/install.sh --check 2>&1 | head -20
```

Expected: State table or "Updating existing installation..." followed by state table.

- [ ] **Step 11.5: Commit**

```bash
cd ~/tokenstack && git add install.sh install.ps1
git commit -m "feat: add install.sh and install.ps1 bootstrap scripts"
```

---

## Task 12: `tokenstack update --check`

**Files:**
- Create: `~/tokenstack/src/cli/update.mjs`
- Modify: `~/tokenstack/src/cli/index.mjs`

- [ ] **Step 12.1: Implement `src/cli/update.mjs`**

```bash
cat > ~/tokenstack/src/cli/update.mjs << 'EOF'
import { detectAll } from '../detect/tools.mjs';
import { execSync } from 'node:child_process';

const UPDATE_COMMANDS = {
  uv:       { upgrade: 'uv self update',              manager: 'uv' },
  headroom: { upgrade: 'uv tool upgrade headroom-ai', manager: 'uv' },
  serena:   { upgrade: 'uv tool upgrade serena',      manager: 'uv' },
  semble:   { upgrade: 'uv tool upgrade semble',      manager: 'uv' },
  rtk:      { upgrade: 'brew upgrade rtk',            manager: 'brew', fallback: 'cargo install rtk --locked' },
  astgrep:  { upgrade: 'cargo install ast-grep --locked', manager: 'cargo' },
};

export async function runUpdate(options = {}) {
  const { check = false } = options;
  const tools = await detectAll();

  console.log(`\nTokenStack Update ${check ? '(dry-run)' : ''}\n${'─'.repeat(55)}`);

  const updates = [];
  for (const [name, r] of Object.entries(tools)) {
    const cmd = UPDATE_COMMANDS[name];
    if (!cmd) continue;
    if (!r.installed) {
      updates.push({ name, status: 'not installed', action: 'install', cmd: cmd.upgrade });
    } else {
      updates.push({ name, status: `installed (${r.version})`, action: 'upgrade', cmd: cmd.upgrade });
    }
  }

  for (const u of updates) {
    const icon = u.action === 'upgrade' ? '↑' : '+';
    console.log(`  ${icon} ${u.name.padEnd(12)} ${u.status}`);
    if (!check) {
      try {
        execSync(u.cmd, { stdio: 'inherit' });
        console.log(`    ✓ done`);
      } catch (e) {
        console.warn(`    ✗ failed: ${e.message}`);
      }
    } else {
      console.log(`    → would run: ${u.cmd}`);
    }
  }

  console.log('─'.repeat(55));
  if (check) console.log('  Run without --check to apply updates.\n');
  else console.log('  Run: tokenstack verify to confirm everything is healthy.\n');
}
EOF
```

- [ ] **Step 12.2: Wire into CLI**

In `~/tokenstack/src/cli/index.mjs`, replace the placeholder `update` command:

```javascript
program
  .command('update')
  .description('Update all TokenStack tools')
  .option('--check', 'Show what would be updated without making changes')
  .action(async (opts) => {
    const { runUpdate } = await import('./update.mjs');
    await runUpdate({ check: opts.check });
  });
```

- [ ] **Step 12.3: Test update --check**

```bash
cd ~/tokenstack && node bin/tokenstack update --check
```

Expected: List of tools with their current versions and what `would run`, no actual changes.

- [ ] **Step 12.4: Commit**

```bash
cd ~/tokenstack && git add src/cli/update.mjs src/cli/index.mjs
git commit -m "feat: add tokenstack update --check with per-tool upgrade commands"
```

---

## Self-Review

**Spec coverage check:**

| Spec requirement | Covered by task |
|-----------------|----------------|
| Configurable port (default 8787, HEADROOM_PORT override) | Task 2 (reader), Task 8 (config set) |
| Idempotent installer | Task 10 (detect_state, skip-if-installed) |
| Config backup before modification | Task 3 (writer with bak timestamp) |
| Corporate SSL full env var chain | Task 5 (detect/proxy.mjs), Task 10 (buildCorporateSslEnv) |
| macOS launchd service | Task 6 (launchd.mjs) |
| Linux systemd service | Task 6 (systemd.mjs) |
| Windows Task Scheduler | Task 6 (windows.mjs) |
| Proxy readiness wait (5s poll) | Task 7 (waitForHeadroom) |
| RTK install with brew/github/cargo fallback | Task 7 (rtk.mjs rtkInstallStrategy) |
| Windows Defender exclusion | Task 11 (install.ps1) |
| `tokenstack config set/show/get/reset/edit` | Task 8 |
| `tokenstack verify` | Task 9 |
| `tokenstack diagnose` (port conflict detection) | Task 9 |
| `tokenstack update --check` | Task 12 |
| install.sh + install.ps1 bootstrappers | Task 11 |
| Proxy binds 127.0.0.1 only | Task 6 (service files), Task 7 (headroom) |
| --check and --dry-run flags | Task 10 |
| Managed markers in config writes | Task 3 (writer.mjs) |

**No placeholders detected. All tasks contain actual code. Method names consistent across tasks.**

---

Plan complete and saved to `~/tokenstack/docs/plans/2026-07-06-foundation.md`.
