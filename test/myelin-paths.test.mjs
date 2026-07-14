import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { join, posix } from 'node:path';
import {
  resolveMyelinRoot,
  managedPaths,
  pathModuleForPlatform,
  isWindowsStylePath,
  joinManaged,
  explicitManagedRoot,
  isManagedRootRelocated,
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

// ── I3: a ~-prefixed or relative MYELIN_DIR/rootDir must never yield
// cwd-dependent state. A leading `~`/`~/`/`~\` expands to home; any still
// non-absolute value is canonicalized against home (never the cwd). Absolute
// roots (either separator style) pass through verbatim. Precedence and
// blank/whitespace handling are preserved.
describe('resolveMyelinRoot — tilde/relative expansion, POSIX root style (I3)', () => {
  it('expands a leading ~/ against the POSIX home', () => {
    assert.equal(resolveMyelinRoot({ home: '/home/alice', rootDir: '~/managed', env: {} }), '/home/alice/managed');
  });
  it('expands a bare ~ to the POSIX home directory', () => {
    assert.equal(resolveMyelinRoot({ home: '/home/alice', rootDir: '~', env: {} }), '/home/alice');
  });
  it('expands a leading ~/ from MYELIN_DIR against the POSIX home', () => {
    assert.equal(resolveMyelinRoot({ home: '/home/alice', env: { MYELIN_DIR: '~/mroot' } }), '/home/alice/mroot');
  });
  it('canonicalizes a relative rootDir against the POSIX home (never the cwd)', () => {
    assert.equal(resolveMyelinRoot({ home: '/home/alice', rootDir: 'managed', env: {} }), '/home/alice/managed');
  });
  it('canonicalizes a relative MYELIN_DIR against the POSIX home', () => {
    assert.equal(resolveMyelinRoot({ home: '/home/alice', env: { MYELIN_DIR: 'state/managed' } }), '/home/alice/state/managed');
  });
  it('passes an absolute POSIX rootDir through verbatim', () => {
    assert.equal(resolveMyelinRoot({ home: '/home/alice', rootDir: '/custom/mroot', env: {} }), '/custom/mroot');
  });
  it('passes a forward-slash UNC rootDir through verbatim (absolute, never canonicalized)', () => {
    assert.equal(resolveMyelinRoot({ home: '/home/alice', rootDir: '//server/share', env: {} }), '//server/share');
  });
});

describe('resolveMyelinRoot — tilde/relative expansion, Windows root style (I3)', () => {
  it('expands a leading ~/ against a Windows home in Windows style', () => {
    assert.equal(resolveMyelinRoot({ home: 'C:\\Users\\u', rootDir: '~/managed', env: {} }), 'C:\\Users\\u\\managed');
  });
  it('expands a leading ~\\ against a Windows home in Windows style', () => {
    assert.equal(resolveMyelinRoot({ home: 'C:\\Users\\u', rootDir: '~\\managed', env: {} }), 'C:\\Users\\u\\managed');
  });
  it('canonicalizes a relative rootDir against a Windows home in Windows style', () => {
    assert.equal(resolveMyelinRoot({ home: 'C:\\Users\\u', rootDir: 'managed', env: {} }), 'C:\\Users\\u\\managed');
  });
  it('passes an absolute Windows rootDir through verbatim', () => {
    assert.equal(resolveMyelinRoot({ home: 'C:\\Users\\u', rootDir: 'D:\\managed', env: {} }), 'D:\\managed');
  });
  it('passes a drive-rooted forward-slash Windows rootDir through verbatim', () => {
    assert.equal(resolveMyelinRoot({ home: 'C:\\Users\\u', rootDir: 'D:/managed', env: {} }), 'D:/managed');
  });
});

describe('resolveMyelinRoot — precedence & blank handling preserved after I3', () => {
  it('still falls back to <home>/.myelin when no explicit root is set', () => {
    assert.equal(resolveMyelinRoot({ home: '/home/alice', env: {} }), '/home/alice/.myelin');
  });
  it('still treats a blank rootDir as absent and falls through to MYELIN_DIR', () => {
    assert.equal(resolveMyelinRoot({ home: '/home/alice', env: { MYELIN_DIR: '/env-root' }, rootDir: '   ' }), '/env-root');
  });
  it('still prefers an explicit rootDir over MYELIN_DIR, expanding both consistently', () => {
    assert.equal(
      resolveMyelinRoot({ home: '/home/alice', env: { MYELIN_DIR: '~/from-env' }, rootDir: '~/from-arg' }),
      '/home/alice/from-arg',
    );
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

// ── I4: forward-slash UNC must be detected as Windows-style ─────────────────
// `//server/share` is a UNC path, not a POSIX-absolute path. Before the fix it
// was misclassified as POSIX and `posix.join` collapsed the leading `//` into a
// single `/`, silently retargeting the managed root to a different location.
describe('isWindowsStylePath — UNC in both slash styles (I4)', () => {
  it('classifies a backslash UNC path as Windows-style', () => {
    assert.equal(isWindowsStylePath('\\\\server\\share'), true);
  });
  it('classifies a forward-slash UNC path as Windows-style', () => {
    assert.equal(isWindowsStylePath('//server/share'), true);
  });
  it('keeps a normal POSIX root POSIX', () => {
    assert.equal(isWindowsStylePath('/home/u/.myelin'), false);
    assert.equal(isWindowsStylePath('/opt/myelin'), false);
  });
});

describe('joinManaged — preserves the UNC prefix in both slash styles (I4)', () => {
  it('does not collapse a forward-slash UNC root', () => {
    // Must stay a UNC path (double leading separator), never `/server/share/...`.
    assert.equal(joinManaged('//server/share', 'x', 'y'), '\\\\server\\share\\x\\y');
  });
  it('keeps a backslash UNC root UNC', () => {
    assert.equal(joinManaged('\\\\server\\share', 'x'), '\\\\server\\share\\x');
  });
});

describe('joinManaged — extends a resolved root in its own separator style', () => {
  it('keeps a POSIX base POSIX and a Windows base backslashed on any host', () => {
    assert.equal(joinManaged('/custom/mroot', 'token-optimizer'), '/custom/mroot/token-optimizer');
    assert.equal(joinManaged('D:\\managed', 'x', 'y'), 'D:\\managed\\x\\y');
    assert.equal(joinManaged('C:\\Users\\u\\.myelin', 'headroom-copilot-8788'), 'C:\\Users\\u\\.myelin\\headroom-copilot-8788');
  });
});

// ── I1: the "relocated" signal must come from an explicit rootDir/MYELIN_DIR
// that resolves to a NON-DEFAULT path — never from mere non-blankness. A
// default install (or an explicit root that points AT <home>/.myelin) is NOT
// relocated, so the portable $HOME-relative profile form is preserved and no
// absolute MYELIN_DIR export is emitted. `myelin update` forwarding the resolved
// default root must therefore NOT be mistaken for a relocation.
describe('explicitManagedRoot — the raw configured root before defaulting', () => {
  it('returns undefined when neither rootDir nor MYELIN_DIR is set', () => {
    assert.equal(explicitManagedRoot({ env: {} }), undefined);
  });

  it('treats a blank/whitespace MYELIN_DIR as absent', () => {
    assert.equal(explicitManagedRoot({ env: { MYELIN_DIR: '   ' } }), undefined);
  });

  it('returns a non-blank MYELIN_DIR verbatim', () => {
    assert.equal(explicitManagedRoot({ env: { MYELIN_DIR: '/custom/mroot' } }), '/custom/mroot');
  });

  it('prefers an explicit rootDir over MYELIN_DIR', () => {
    assert.equal(
      explicitManagedRoot({ env: { MYELIN_DIR: '/env-root' }, rootDir: '/explicit' }),
      '/explicit',
    );
  });
});

describe('isManagedRootRelocated — non-default explicit root only (I1)', () => {
  it('is false for a default install (no rootDir/MYELIN_DIR)', () => {
    assert.equal(isManagedRootRelocated({ home, env: {}, platform: 'linux' }), false);
  });

  it('is false when MYELIN_DIR is explicitly set to the default <home>/.myelin', () => {
    assert.equal(
      isManagedRootRelocated({ home, env: { MYELIN_DIR: '/home/alice/.myelin' }, platform: 'linux' }),
      false,
    );
  });

  it('is false when MYELIN_DIR is the default with a trailing slash', () => {
    assert.equal(
      isManagedRootRelocated({ home, env: { MYELIN_DIR: '/home/alice/.myelin/' }, platform: 'linux' }),
      false,
    );
  });

  it('is true when MYELIN_DIR resolves somewhere other than the default', () => {
    assert.equal(
      isManagedRootRelocated({ home, env: { MYELIN_DIR: '/custom/mroot' }, platform: 'linux' }),
      true,
    );
  });

  it('is true when an explicit rootDir relocates the root', () => {
    assert.equal(
      isManagedRootRelocated({ home, env: {}, rootDir: '/custom/mroot', platform: 'linux' }),
      true,
    );
  });

  it('is false when the Windows MYELIN_DIR equals the default Windows root', () => {
    assert.equal(
      isManagedRootRelocated({
        home: 'C:\\Users\\alice',
        env: { MYELIN_DIR: 'C:\\Users\\alice\\.myelin' },
        platform: 'windows',
      }),
      false,
    );
  });

  it('is true for a relocated Windows drive root', () => {
    assert.equal(
      isManagedRootRelocated({
        home: 'C:\\Users\\alice',
        env: { MYELIN_DIR: 'D:\\managed' },
        platform: 'windows',
      }),
      true,
    );
  });
});
