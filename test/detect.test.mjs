import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { join } from 'node:path';
import { detectOS, detectShell } from '../src/detect/os.mjs';
import { detectTool, detectUv, detectNode, detectCopilotHud } from '../src/detect/tools.mjs';
import { detectCorporateProxy, detectCaBundles } from '../src/detect/proxy.mjs';
import { isPortFree, findFreePort } from '../src/detect/port.mjs';

describe('detectOS', () => {
  it('returns darwin, linux, or windows', () => {
    const os = detectOS();
    assert.ok(['darwin', 'linux', 'windows'].includes(os), `unexpected: ${os}`);
  });
  it('returns arch string when detailed=true', () => {
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
  it('returns object with installed, version, path keys', async () => {
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

describe('detectCopilotHud', () => {
  it('returns installed=false when Copilot CLI is missing', async () => {
    const r = await detectCopilotHud({
      detectToolImpl: async () => ({ installed: false, version: null, path: null }),
    });
    assert.deepEqual(r, { installed: false, version: null, path: null });
  });

  it('detects the plugin from copilot plugin list output', async () => {
    const homeDir = join('test-home');
    const pluginPath = join(homeDir, '.copilot', 'plugins', 'copilot-hud');
    const r = await detectCopilotHud({
      detectToolImpl: async () => ({ installed: true, version: '1.0.12', path: '/usr/local/bin/copilot' }),
      execSyncImpl: () => Buffer.from('copilot-hud 0.4.2\nother-plugin 1.0.0\n'),
      existsSyncImpl: (path) => path === pluginPath,
      homeDir,
    });
    assert.deepEqual(r, { installed: true, version: '0.4.2', path: pluginPath });
  });

  it('allows null version/path for plugin installs without extra metadata', async () => {
    const r = await detectCopilotHud({
      detectToolImpl: async () => ({ installed: true, version: '1.0.12', path: '/usr/local/bin/copilot' }),
      execSyncImpl: () => Buffer.from('copilot-hud\n'),
      existsSyncImpl: () => false,
      homeDir: join('test-home'),
    });
    assert.deepEqual(r, { installed: true, version: null, path: null });
  });

  it('returns installed=false when copilot plugin list does not include copilot-hud', async () => {
    const r = await detectCopilotHud({
      detectToolImpl: async () => ({ installed: true, version: '1.0.12', path: '/usr/local/bin/copilot' }),
      execSyncImpl: () => Buffer.from('other-plugin 1.0.0\n'),
    });
    assert.deepEqual(r, { installed: false, version: null, path: null });
  });
});

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
