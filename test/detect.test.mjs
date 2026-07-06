import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { detectOS, detectShell } from '../src/detect/os.mjs';
import { detectTool, detectUv, detectNode } from '../src/detect/tools.mjs';
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
