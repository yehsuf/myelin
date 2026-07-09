import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  disableSerenaDashboardAutoOpen,
  serenaConfigPath,
  applyDisableSerenaDashboardAutoOpen,
} from '../src/service/serena-config.mjs';

const REALISTIC_CONFIG = `# some heavily commented header
# explaining what this file is for
language_backend: LSP

# whether to start the Serena Dashboard
web_dashboard: true

# whether to open the Dashboard window/browser tab when Serena starts
#  * browser: the dashboard is opened in the default browser (if \`web_dashboard_open_on_launch\` is true)
web_dashboard_open_on_launch: true

web_dashboard_listen_address: 127.0.0.1
`;

describe('disableSerenaDashboardAutoOpen', () => {
  it('flips the real key from true to false', () => {
    const result = disableSerenaDashboardAutoOpen(REALISTIC_CONFIG);
    assert.ok(result.includes('\nweb_dashboard_open_on_launch: false\n'));
  });

  it('does not touch comment lines that merely mention the key', () => {
    const result = disableSerenaDashboardAutoOpen(REALISTIC_CONFIG);
    assert.ok(result.includes('#  * browser: the dashboard is opened in the default browser (if `web_dashboard_open_on_launch` is true)'));
  });

  it('preserves every other line of the file untouched', () => {
    const result = disableSerenaDashboardAutoOpen(REALISTIC_CONFIG);
    const before = REALISTIC_CONFIG.split('\n').filter((l) => l !== 'web_dashboard_open_on_launch: true');
    const after = result.split('\n').filter((l) => l !== 'web_dashboard_open_on_launch: false');
    assert.deepEqual(after, before);
  });

  it('is idempotent - already false is left unchanged', () => {
    const alreadyFalse = REALISTIC_CONFIG.replace('web_dashboard_open_on_launch: true', 'web_dashboard_open_on_launch: false');
    assert.equal(disableSerenaDashboardAutoOpen(alreadyFalse), alreadyFalse);
  });

  it('is a no-op (never throws) when the key is entirely absent', () => {
    const noKey = 'language_backend: LSP\n';
    assert.doesNotThrow(() => disableSerenaDashboardAutoOpen(noKey));
    assert.equal(disableSerenaDashboardAutoOpen(noKey), noKey);
  });

  it('tolerates trailing whitespace after the value', () => {
    const withTrailingSpace = 'web_dashboard_open_on_launch: true   \n';
    assert.equal(disableSerenaDashboardAutoOpen(withTrailingSpace), 'web_dashboard_open_on_launch: false\n');
  });
});

describe('serenaConfigPath', () => {
  it('joins home with .serena/serena_config.yml', () => {
    assert.equal(serenaConfigPath('/Users/test'), join('/Users/test', '.serena', 'serena_config.yml'));
  });
});

describe('applyDisableSerenaDashboardAutoOpen', () => {
  it('returns false (no-op) when the config file does not exist yet', () => {
    const home = mkdtempSync(join(tmpdir(), 'myelin-serena-config-test-'));
    try {
      assert.equal(applyDisableSerenaDashboardAutoOpen(home), false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('patches a real config file in place and returns true', () => {
    const home = mkdtempSync(join(tmpdir(), 'myelin-serena-config-test-'));
    try {
      mkdirSync(join(home, '.serena'), { recursive: true });
      writeFileSync(serenaConfigPath(home), REALISTIC_CONFIG, 'utf8');

      const changed = applyDisableSerenaDashboardAutoOpen(home);

      assert.equal(changed, true);
      const result = readFileSync(serenaConfigPath(home), 'utf8');
      assert.ok(result.includes('web_dashboard_open_on_launch: false'));
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('is idempotent - returns false on the second call', () => {
    const home = mkdtempSync(join(tmpdir(), 'myelin-serena-config-test-'));
    try {
      mkdirSync(join(home, '.serena'), { recursive: true });
      writeFileSync(serenaConfigPath(home), REALISTIC_CONFIG, 'utf8');

      applyDisableSerenaDashboardAutoOpen(home);
      const secondCallChanged = applyDisableSerenaDashboardAutoOpen(home);

      assert.equal(secondCallChanged, false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('never throws even if the file is unreadable garbage', () => {
    const home = mkdtempSync(join(tmpdir(), 'myelin-serena-config-test-'));
    try {
      mkdirSync(join(home, '.serena'), { recursive: true });
      writeFileSync(serenaConfigPath(home), Buffer.from([0xff, 0xfe, 0x00, 0x01]));
      assert.doesNotThrow(() => applyDisableSerenaDashboardAutoOpen(home));
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
