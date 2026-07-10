import { describe, it, before, after } from 'node:test';
import { strict as assert } from 'node:assert';
import { writeFileSync, mkdirSync, rmSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { DEFAULT_CONFIG, mergeDeep, pruneUnknownKeys } from '../src/config/schema.mjs';
import { loadConfig, readUserConfig, DEFAULT_CONFIG_PATH } from '../src/config/reader.mjs';
import { writeConfig, setConfigValue, getConfigValue } from '../src/config/writer.mjs';
import { platformConfigBanner, pruneConfig } from '../src/cli/config-cmd.mjs';

const TEST_DIR = join(homedir(), '.tokenstack-test');

function captureLogs() {
  const logs = [];
  return {
    logs,
    log: (message = '') => logs.push(message),
  };
}

function backupFiles(dir, baseName) {
  return readdirSync(dir).filter(file => file.startsWith(`${baseName}.bak.`));
}

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
  it('DEFAULT_CONFIG has proxy.headroom.mode = cache (prefix-stable, cache-hit optimized)', () => {
    assert.equal(DEFAULT_CONFIG.proxy.headroom.mode, 'cache');
  });
  it('DEFAULT_CONFIG has proxy.headroom.intercept_tool_results = true', () => {
    assert.equal(DEFAULT_CONFIG.proxy.headroom.intercept_tool_results, true);
  });
  it('DEFAULT_CONFIG has index_tier = default', () => {
    assert.equal(DEFAULT_CONFIG.index_tier, 'default');
  });
  it('DEFAULT_CONFIG has code_discovery.codegraph = false (opt-in)', () => {
    assert.equal(DEFAULT_CONFIG.code_discovery.codegraph, false);
  });
  it('DEFAULT_CONFIG enables myelin-native deterministic compression helpers', () => {
    assert.equal(DEFAULT_CONFIG.native_compression.cross_turn_dedup, true);
    assert.equal(DEFAULT_CONFIG.native_compression.adaptive_sizer, true);
    assert.equal(DEFAULT_CONFIG.native_compression.lossless_compaction, true);
  });
  it('DEFAULT_CONFIG has proxy.mitm.port = 8888', () => {
    assert.equal(DEFAULT_CONFIG.proxy.mitm.port, 8888);
  });
  it('DEFAULT_CONFIG has proxy.mitm.egress_port = 8889', () => {
    assert.equal(DEFAULT_CONFIG.proxy.mitm.egress_port, 8889);
  });
  it('DEFAULT_CONFIG has proxy.copilot_headroom.enabled = false (opt-in)', () => {
    assert.equal(DEFAULT_CONFIG.proxy.copilot_headroom.enabled, false);
  });
  it('DEFAULT_CONFIG has proxy.copilot_headroom.port = 8788', () => {
    assert.equal(DEFAULT_CONFIG.proxy.copilot_headroom.port, 8788);
  });
  it('DEFAULT_CONFIG has proxy.copilot_headroom target URLs pointed at Copilot Business', () => {
    assert.equal(DEFAULT_CONFIG.proxy.copilot_headroom.anthropic_target_url, 'https://api.business.githubcopilot.com');
    assert.equal(DEFAULT_CONFIG.proxy.copilot_headroom.openai_target_url, 'https://api.business.githubcopilot.com');
  });
  it('DEFAULT_CONFIG has proxy.windows_service.manager = registry (safe default, unchanged behavior)', () => {
    assert.equal(DEFAULT_CONFIG.proxy.windows_service.manager, 'registry');
  });
  it('DEFAULT_CONFIG has proxy.windows_service.watchdog_enabled = false (opt-in)', () => {
    assert.equal(DEFAULT_CONFIG.proxy.windows_service.watchdog_enabled, false);
  });
  it('DEFAULT_CONFIG has proxy.windows_service.watchdog_interval_minutes = 2', () => {
    assert.equal(DEFAULT_CONFIG.proxy.windows_service.watchdog_interval_minutes, 2);
  });
  it('DEFAULT_CONFIG excludes removed vaporware keys', () => {
    for (const key of ['conversation_memory', 'stacklit', 'semgrep', 'learning']) {
      assert.equal(key in DEFAULT_CONFIG, false);
    }
    assert.equal('helicone' in DEFAULT_CONFIG.observability, false);
    assert.equal('ai_engineering_coach' in DEFAULT_CONFIG.observability, false);
    assert.equal('headroom_learn' in (DEFAULT_CONFIG.learning ?? {}), false);
    assert.equal('srt' in DEFAULT_CONFIG.output_sandboxing, false);
  });
  it('DEFAULT_CONFIG has budget_routing defaults (opt-in)', () => {
    assert.equal(DEFAULT_CONFIG.budget_routing.litellm, false);
    assert.equal(DEFAULT_CONFIG.budget_routing.litellm_port, 4000);
    assert.equal(DEFAULT_CONFIG.budget_routing.cheap_model, 'claude-haiku-4-5');
    assert.equal(DEFAULT_CONFIG.budget_routing.complex_model, 'claude-sonnet-4-6');
    assert.equal(DEFAULT_CONFIG.budget_routing.cheap_threshold, 0.3);
  });
  it('DEFAULT_CONFIG has observability.token_optimizer = false (opt-in)', () => {
    assert.equal(DEFAULT_CONFIG.observability.token_optimizer, false);
  });
  it('DEFAULT_CONFIG retains real config keys unchanged', () => {
    assert.equal(DEFAULT_CONFIG.output_sandboxing.context_mode, true);
    assert.equal(DEFAULT_CONFIG.code_discovery.serena.lsp.rust, false);
  });
  it('DEFAULT_CONFIG has copilot_hud.enabled = false (opt-in)', () => {
    assert.equal(DEFAULT_CONFIG.copilot_hud.enabled, false);
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
  it('pruneUnknownKeys removes flat stale keys', () => {
    const result = pruneUnknownKeys({ index_tier: 'full', old_flag: true });
    assert.deepEqual(result, { index_tier: 'full' });
  });
  it('pruneUnknownKeys removes nested stale sections', () => {
    const result = pruneUnknownKeys({
      conversation_memory: { mem0: true },
      proxy: { headroom: { port: 9999 } },
    });
    assert.deepEqual(result, { proxy: { headroom: { port: 9999 } } });
  });
  it('pruneUnknownKeys preserves real user values unchanged', () => {
    const result = pruneUnknownKeys({
      proxy: { headroom: { port: 9999 } },
      output_sandboxing: { context_mode: false, srt: true },
    });
    assert.deepEqual(result, {
      proxy: { headroom: { port: 9999 } },
      output_sandboxing: { context_mode: false },
    });
  });
  it('pruneUnknownKeys returns clean configs unchanged', () => {
    const userConfig = {
      proxy: { headroom: { port: 9999, enabled: false } },
      output_style: { hooks: false, code_navigation: true },
    };
    assert.deepEqual(pruneUnknownKeys(userConfig), userConfig);
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
    const saved = process.env.HEADROOM_PORT;
    delete process.env.HEADROOM_PORT;  // isolate from env override
    const cfg = await loadConfig(cfgPath);
    if (saved !== undefined) process.env.HEADROOM_PORT = saved;
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

describe('config writer', () => {
  before(() => mkdirSync(TEST_DIR, { recursive: true }));
  after(() => rmSync(TEST_DIR, { recursive: true, force: true }));
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

describe('config CLI banner', () => {
  it('includes the real config path and stays under 20 words', () => {
    const banner = platformConfigBanner('linux', DEFAULT_CONFIG_PATH);
    assert.ok(banner.includes(DEFAULT_CONFIG_PATH));
    assert.ok(banner.split(/\s+/).length < 20, `expected under 20 words, got: ${banner}`);
  });

  it('mentions notepad on win32', () => {
    const banner = platformConfigBanner('win32', 'C:\\Users\\alice\\.myelin\\config.yaml');
    assert.ok(banner.includes('notepad'));
  });

  it('mentions nano on non-win32 platforms', () => {
    const banner = platformConfigBanner('darwin', '/Users/alice/.myelin/config.yaml');
    assert.ok(banner.includes('nano'));
  });
});

describe('config prune', () => {
  before(() => mkdirSync(TEST_DIR, { recursive: true }));
  after(() => rmSync(TEST_DIR, { recursive: true, force: true }));

  it('reports when there is nothing to prune', async () => {
    const dir = join(TEST_DIR, 'prune-clean');
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    const configPath = join(dir, 'config.yaml');
    writeFileSync(configPath, 'proxy:\n  headroom:\n    port: 9999\n', 'utf8');
    const before = readFileSync(configPath, 'utf8');
    const consoleCapture = captureLogs();

    const result = await pruneConfig({ configPath, log: consoleCapture.log });

    assert.equal(result.changed, false);
    assert.deepEqual(result.staleKeys, []);
    assert.deepEqual(consoleCapture.logs, ['✓ No stale config keys found.']);
    assert.equal(readFileSync(configPath, 'utf8'), before);
    assert.deepEqual(backupFiles(dir, 'config.yaml'), []);
  });

  it('previews stale keys on dry-run without rewriting the file', async () => {
    const dir = join(TEST_DIR, 'prune-dry-run');
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    const configPath = join(dir, 'config.yaml');
    writeFileSync(configPath, [
      'proxy:',
      '  headroom:',
      '    port: 9999',
      'conversation_memory:',
      '  mem0: true',
      'learning:',
      '  headroom_learn: true',
      'output_sandboxing:',
      '  context_mode: false',
      '  srt: true',
      '',
    ].join('\n'), 'utf8');
    const before = readFileSync(configPath, 'utf8');
    const consoleCapture = captureLogs();

    const result = await pruneConfig({ configPath, dryRun: true, log: consoleCapture.log });

    assert.equal(result.changed, false);
    assert.deepEqual(result.staleKeys, [
      'conversation_memory.mem0',
      'learning.headroom_learn',
      'output_sandboxing.srt',
    ]);
    assert.deepEqual(consoleCapture.logs, [
      'Stale config keys to remove:',
      '  - conversation_memory.mem0',
      '  - learning.headroom_learn',
      '  - output_sandboxing.srt',
      `✓ Dry run: 3 stale key(s) would be removed from ~/.tokenstack-test/prune-dry-run/config.yaml.`,
    ]);
    assert.equal(readFileSync(configPath, 'utf8'), before);
    assert.deepEqual(backupFiles(dir, 'config.yaml'), []);
  });

  it('rewrites the config and creates a backup when stale keys exist', async () => {
    const dir = join(TEST_DIR, 'prune-write');
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    const configPath = join(dir, 'config.yaml');
    writeFileSync(configPath, [
      'proxy:',
      '  headroom:',
      '    port: 9999',
      'conversation_memory:',
      '  mem0: true',
      'output_sandboxing:',
      '  context_mode: false',
      '  srt: true',
      '',
    ].join('\n'), 'utf8');
    const consoleCapture = captureLogs();

    const result = await pruneConfig({ configPath, log: consoleCapture.log });
    const pruned = readUserConfig(configPath);

    assert.equal(result.changed, true);
    assert.deepEqual(result.staleKeys, [
      'conversation_memory.mem0',
      'output_sandboxing.srt',
    ]);
    assert.deepEqual(pruned, {
      proxy: { headroom: { port: 9999 } },
      output_sandboxing: { context_mode: false },
    });
    assert.ok(backupFiles(dir, 'config.yaml').length >= 1);
    assert.deepEqual(consoleCapture.logs, [
      'Stale config keys to remove:',
      '  - conversation_memory.mem0',
      '  - output_sandboxing.srt',
      `✓ Pruned 2 stale key(s) from ~/.tokenstack-test/prune-write/config.yaml (backup saved).`,
    ]);
  });
});
