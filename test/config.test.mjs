import { describe, it, before, after } from 'node:test';
import { strict as assert } from 'node:assert';
import { writeFileSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { DEFAULT_CONFIG, mergeDeep } from '../src/config/schema.mjs';
import { loadConfig, DEFAULT_CONFIG_PATH } from '../src/config/reader.mjs';
import { writeConfig, setConfigValue, getConfigValue } from '../src/config/writer.mjs';
import { platformConfigBanner } from '../src/cli/config-cmd.mjs';

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
  it('DEFAULT_CONFIG has proxy.headroom.mode = cache (prefix-stable, cache-hit optimized)', () => {
    assert.equal(DEFAULT_CONFIG.proxy.headroom.mode, 'cache');
  });
  it('DEFAULT_CONFIG has proxy.headroom.intercept_tool_results = true', () => {
    assert.equal(DEFAULT_CONFIG.proxy.headroom.intercept_tool_results, true);
  });
  it('DEFAULT_CONFIG has index_tier = default', () => {
    assert.equal(DEFAULT_CONFIG.index_tier, 'default');
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
  it('DEFAULT_CONFIG excludes removed vaporware keys', () => {
    for (const key of ['conversation_memory', 'observability', 'stacklit', 'semgrep', 'budget_routing', 'learning']) {
      assert.equal(key in DEFAULT_CONFIG, false);
    }
    assert.equal('srt' in DEFAULT_CONFIG.output_sandboxing, false);
  });
  it('DEFAULT_CONFIG retains real config keys unchanged', () => {
    assert.equal(DEFAULT_CONFIG.output_sandboxing.context_mode, true);
    assert.equal(DEFAULT_CONFIG.code_discovery.serena.lsp.rust, false);
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
