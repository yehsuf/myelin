import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { join, posix } from 'node:path';
import {
  resolveMyelinRoot,
  managedPaths,
  pathModuleForPlatform,
  isWindowsStylePath,
  joinManaged,
} from '../src/shared/myelin-paths.mjs';

const home = '/home/alice';
const def = join(home, '.myelin');

describe('resolveMyelinRoot precedence', () => {
  it('uses an explicit non-empty rootDir above everything', () => {
    assert.equal(
      resolveMyelinRoot({ home, env: { MYELIN_DIR: '/env-root' }, rootDir: '/explicit' }),
      '/explicit',
    );
  });

  it('treats a blank rootDir as absent and falls through to MYELIN_DIR', () => {
    assert.equal(
      resolveMyelinRoot({ home, env: { MYELIN_DIR: '/env-root' }, rootDir: '' }),
      '/env-root',
    );
  });

  it('treats a whitespace-only rootDir as absent and falls through to MYELIN_DIR', () => {
    assert.equal(
      resolveMyelinRoot({ home, env: { MYELIN_DIR: '/env-root' }, rootDir: '   ' }),
      '/env-root',
    );
  });

  it('uses a non-empty MYELIN_DIR when no rootDir is supplied', () => {
    assert.equal(
      resolveMyelinRoot({ home, env: { MYELIN_DIR: '/env-root' } }),
      '/env-root',
    );
  });

  it('ignores a blank MYELIN_DIR and uses the default managed root', () => {
    assert.equal(resolveMyelinRoot({ home, env: { MYELIN_DIR: '   ' } }), def);
  });

  it('ignores a blank MYELIN_DIR even when rootDir is also blank', () => {
    assert.equal(resolveMyelinRoot({ home, env: { MYELIN_DIR: '' }, rootDir: '  ' }), def);
  });

  it('falls back to <home>/.myelin when neither rootDir nor MYELIN_DIR is set', () => {
    assert.equal(resolveMyelinRoot({ home, env: {} }), def);
  });

  it('managedPaths derives every path from the resolved root (MYELIN_DIR-aware)', () => {
    const p = managedPaths({ home, env: { MYELIN_DIR: '/env-root' } });
    assert.equal(p.root, '/env-root');
    assert.equal(p.configPath, posix.join('/env-root', 'config.yaml'));
    assert.equal(p.venvPath, posix.join('/env-root', 'venv'));
  });
});

// ── Explicit-platform separators (the Windows-host regression) ──────────────
// These prove the output separator is decided by the EXPLICIT `platform` input,
// never the host's process.platform. They must hold identically on a POSIX host
// and a Windows host: a simulated darwin/linux target always yields POSIX paths,
// and a simulated win32 target always yields backslashed paths.
describe('managedPaths — explicit platform selects separators host-independently', () => {
  for (const platform of ['linux', 'darwin']) {
    it(`yields POSIX paths for platform='${platform}' regardless of host`, () => {
      const p = managedPaths({ home: '/home/u', platform });
      assert.equal(p.root, '/home/u/.myelin');
      assert.equal(p.binDir, '/home/u/.myelin/bin');
      assert.equal(p.venvPath, '/home/u/.myelin/venv');
      assert.equal(p.launcherPath, '/home/u/.myelin/bin/myelin-launcher.mjs');
      assert.equal(p.runtimeBridgeRoot, '/home/u/.myelin/runtime-bridge');
      assert.ok(!p.root.includes('\\'), p.root);
    });
  }

  for (const platform of ['win32', 'windows']) {
    it(`yields Windows paths for platform='${platform}' regardless of host`, () => {
      const p = managedPaths({ home: 'C:\\Users\\u', platform });
      assert.equal(p.root, 'C:\\Users\\u\\.myelin');
      assert.equal(p.binDir, 'C:\\Users\\u\\.myelin\\bin');
      assert.equal(p.launcherPath, 'C:\\Users\\u\\.myelin\\bin\\myelin-launcher.mjs');
      assert.ok(!p.binDir.includes('/'), p.binDir);
    });
  }

  it('applies the explicit platform to the default-root join, not the host', () => {
    // A POSIX home + platform:'win32' still backslashes the default join, and a
    // Windows home + platform:'linux' still forward-slashes it — output tracks
    // the explicit token, so the same call is deterministic on any host.
    assert.equal(resolveMyelinRoot({ home: '/home/u', env: {}, platform: 'win32' }), '\\home\\u\\.myelin');
    assert.equal(resolveMyelinRoot({ home: 'C:/Users/u', env: {}, platform: 'linux' }), 'C:/Users/u/.myelin');
  });

  it('leaves an explicit MYELIN_DIR/rootDir untouched by platform', () => {
    // A relocated root is used verbatim — its separators come from the caller's
    // string, so platform only governs the default-root join.
    assert.equal(managedPaths({ home: '/home/u', env: { MYELIN_DIR: '/custom/mroot' }, platform: 'win32' }).root, '/custom/mroot');
    assert.equal(managedPaths({ home: '/home/u', rootDir: 'D:\\managed', platform: 'linux' }).root, 'D:\\managed');
  });

  it('derives derived-path separators from the resolved root when an explicit Windows root conflicts with a POSIX platform', () => {
    // Windows-style explicit root + POSIX platform must NOT splice a POSIX
    // separator into the derived paths — the whole path stays backslashed.
    const p = managedPaths({ home: '/home/u', rootDir: 'D:\\managed', platform: 'linux' });
    assert.equal(p.root, 'D:\\managed');
    assert.equal(p.configPath, 'D:\\managed\\config.yaml');
    assert.equal(p.binDir, 'D:\\managed\\bin');
    assert.equal(p.venvPath, 'D:\\managed\\venv');
    assert.equal(p.launcherPath, 'D:\\managed\\bin\\myelin-launcher.mjs');
    assert.ok(!p.configPath.includes('/'), p.configPath);
  });

  it('derives derived-path separators from the resolved root when an explicit POSIX MYELIN_DIR conflicts with a Windows platform', () => {
    // POSIX-style explicit MYELIN_DIR + win32 platform must NOT splice a
    // backslash into the derived paths — the whole path stays forward-slashed.
    const p = managedPaths({ home: 'C:\\Users\\u', env: { MYELIN_DIR: '/custom/mroot' }, platform: 'win32' });
    assert.equal(p.root, '/custom/mroot');
    assert.equal(p.configPath, '/custom/mroot/config.yaml');
    assert.equal(p.binDir, '/custom/mroot/bin');
    assert.equal(p.launcherPath, '/custom/mroot/bin/myelin-launcher.mjs');
    assert.ok(!p.configPath.includes('\\'), p.configPath);
  });
});

describe('pathModuleForPlatform', () => {
  it('maps win32/windows tokens to the Windows implementation', () => {
    assert.equal(pathModuleForPlatform('win32').sep, '\\');
    assert.equal(pathModuleForPlatform('windows').sep, '\\');
  });
  it('maps every other token to the POSIX implementation', () => {
    for (const t of ['linux', 'darwin', 'freebsd', 'wsl']) {
      assert.equal(pathModuleForPlatform(t).sep, '/');
    }
  });
});

describe('isWindowsStylePath', () => {
  it('detects drive-rooted, UNC and backslash paths as Windows-style', () => {
    assert.equal(isWindowsStylePath('C:\\Users\\u'), true);
    assert.equal(isWindowsStylePath('C:/Users/u'), true);
    assert.equal(isWindowsStylePath('\\\\server\\share'), true);
    assert.equal(isWindowsStylePath('relative\\path'), true);
  });
  it('treats POSIX-absolute and clean relative paths as non-Windows', () => {
    assert.equal(isWindowsStylePath('/home/u/.myelin'), false);
    assert.equal(isWindowsStylePath('a/b/c'), false);
    assert.equal(isWindowsStylePath(''), false);
    assert.equal(isWindowsStylePath(undefined), false);
  });
});

describe('joinManaged — extends a resolved root in its own separator style', () => {
  it('keeps a POSIX base POSIX and a Windows base backslashed on any host', () => {
    assert.equal(joinManaged('/custom/mroot', 'token-optimizer'), '/custom/mroot/token-optimizer');
    assert.equal(joinManaged('D:\\managed', 'x', 'y'), 'D:\\managed\\x\\y');
    assert.equal(joinManaged('C:\\Users\\u\\.myelin', 'headroom-copilot-8788'), 'C:\\Users\\u\\.myelin\\headroom-copilot-8788');
  });
});
