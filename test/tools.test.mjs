import { after, describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import { detectRtkHookArtifacts, getRtkVersionStatus, parseRtkVersion, RTK_PINNED_VERSION, rtkInstallStrategy } from '../src/tools/rtk.mjs';
import { buildGuardedRtkCopilotHook } from '../src/tools/rtk.mjs';
import { parseHeadroomVersion, headroomHealthUrl } from '../src/tools/headroom.mjs';
import * as winswTools from '../src/tools/winsw.mjs';
import { detectWinsw, getWinswVersionStatus, parseWinswVersion, selectWinswAsset, WINSW_PINNED_VERSION, winswBinPath, winswReleaseApiUrl } from '../src/tools/winsw.mjs';
import { writeManagedLauncher } from '../src/runtime/launcher.mjs';
import { linkGlobalBin } from '../src/service/npmlink.mjs';

function makeTempHome(name) {
  const home = join(process.cwd(), '.test-artifacts', `${name}-${process.pid}-${randomBytes(4).toString('hex')}`);
  rmSync(home, { recursive: true, force: true });
  mkdirSync(home, { recursive: true });
  return home;
}

describe('RTK version parsing', () => {
  it('parses version from rtk --version output', () => {
    const v = parseRtkVersion('rtk 0.5.1');
    assert.equal(v, '0.5.1');
  });
  it('returns null for empty string', () => {
    assert.equal(parseRtkVersion(''), null);
  });
  it('returns null for unrecognised output', () => {
    assert.equal(parseRtkVersion('not a version'), null);
  });
  it('tracks whether the version matches the pinned RTK release', () => {
    const pinned = getRtkVersionStatus(`rtk ${RTK_PINNED_VERSION}`);
    const newer = getRtkVersionStatus('rtk 9.9.9');
    assert.equal(pinned.pinnedVersionMatches, true);
    assert.equal(newer.pinnedVersionMatches, false);
    assert.equal(newer.pinnedVersion, RTK_PINNED_VERSION);
  });
});

describe('RTK install strategy', () => {
  it('returns brew on darwin', () => {
    const s = rtkInstallStrategy('darwin');
    assert.equal(s[0].method, 'brew');
  });
  it('returns github_release first on linux', () => {
    const s = rtkInstallStrategy('linux');
    assert.equal(s[0].method, 'github_release');
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

describe('WinSW version parsing', () => {
  it('parses a prerelease WinSW version', () => {
    assert.equal(parseWinswVersion('WinSW 3.0.0-alpha.11'), '3.0.0-alpha.11');
  });
  it('tracks whether the version matches the pinned WinSW release', () => {
    const pinned = getWinswVersionStatus(`WinSW ${WINSW_PINNED_VERSION.replace(/^v/, '')}`);
    const other = getWinswVersionStatus('WinSW 2.12.0');
    assert.equal(pinned.pinnedVersionMatches, true);
    assert.equal(other.pinnedVersionMatches, false);
    assert.equal(other.pinnedVersion, WINSW_PINNED_VERSION.replace(/^v/, ''));
  });
  it('builds the GitHub release API URL for the pinned tag', () => {
    assert.equal(
      winswReleaseApiUrl(),
      `https://api.github.com/repos/winsw/winsw/releases/tags/${WINSW_PINNED_VERSION}`
    );
  });
});

describe('WinSW asset selection', () => {
  const release = {
    assets: [
      { name: 'WinSW-net461.exe', browser_download_url: 'https://example.test/net461' },
      { name: 'WinSW-x64.exe', browser_download_url: 'https://example.test/x64' },
      { name: 'WinSW-x86.exe', browser_download_url: 'https://example.test/x86' },
    ],
  };

  it('prefers the self-contained x64 asset on x64', () => {
    assert.equal(selectWinswAsset(release, { arch: 'x64' })?.name, 'WinSW-x64.exe');
  });

  it('falls back to the .NET 4.6.1 asset when requested', () => {
    assert.equal(selectWinswAsset(release, { arch: 'x64', preferNetFx: true })?.name, 'WinSW-net461.exe');
  });

  it('selects the x86 asset on 32-bit installs', () => {
    assert.equal(selectWinswAsset(release, { arch: 'ia32' })?.name, 'WinSW-x86.exe');
  });
});

describe('detectWinsw', () => {
  it('checks the managed ~/.myelin/bin location and parses --version output', () => {
    const home = 'C:\\Users\\alice';
    const state = detectWinsw({
      home,
      existsSyncImpl: (path) => path === winswBinPath({ home }),
      execFileSyncImpl: () => Buffer.from(`WinSW ${WINSW_PINNED_VERSION.replace(/^v/, '')}\n`),
    });
    assert.equal(state.installed, true);
    assert.equal(state.path, 'C:\\Users\\alice\\.myelin\\bin\\winsw.exe');
    assert.equal(state.parsedVersion, WINSW_PINNED_VERSION.replace(/^v/, ''));
  });

  it('maps WinSW assets to a WSL-mounted filesystem path without altering its Windows command path', () => {
    assert.equal(
      winswTools.winswFilesystemPath('C:\\Users\\alice\\.myelin\\bin\\winsw.exe', { wsl: true }),
      '/mnt/c/Users/alice/.myelin/bin/winsw.exe',
    );
  });

  it('I5: returns a NATIVE D:\\ WinSW command path when the managed root is a mounted /mnt/d WSL path', () => {
    const env = { MYELIN_DIR: '/mnt/d/managed' };
    // PowerShell/WinSW consume the command path natively, so it MUST be D:\...
    assert.equal(
      winswBinPath({ home: '/home/alice', env }),
      'D:\\managed\\bin\\winsw.exe',
    );
    // ...while the Node-filesystem view of that command path stays under /mnt/d.
    assert.equal(
      winswTools.winswFilesystemPath(winswBinPath({ home: '/home/alice', env }), { wsl: true }),
      '/mnt/d/managed/bin/winsw.exe',
    );
  });

  it('I5: downloads WinSW to the /mnt/d filesystem path while keeping the native D:\\ command path', async () => {
    const filesystemOps = [];
    const responses = [
      {
        ok: true,
        json: async () => ({
          assets: [{ name: 'WinSW-x64.exe', browser_download_url: 'https://example.test/winsw.exe' }],
        }),
      },
      { ok: true, arrayBuffer: async () => Uint8Array.from([1, 2, 3]).buffer },
    ];
    const result = await winswTools.downloadWinsw({
      home: '/home/alice',
      env: { MYELIN_DIR: '/mnt/d/managed' },
      arch: 'x64',
      wsl: true,
      fetchImpl: async () => responses.shift(),
      mkdirSyncImpl: (path) => filesystemOps.push({ op: 'mkdir', path }),
      writeFileSyncImpl: (path) => filesystemOps.push({ op: 'write', path }),
      chmodSyncImpl: (path) => filesystemOps.push({ op: 'chmod', path }),
    });

    assert.equal(result.path, 'D:\\managed\\bin\\winsw.exe');
    assert.equal(result.filesystemPath, '/mnt/d/managed/bin/winsw.exe');
    assert.ok(filesystemOps.every(({ path }) => path.startsWith('/mnt/d/')));
  });

  it('downloads WinSW through its mounted filesystem path while retaining the Windows command path', async () => {
    const filesystemOps = [];
    const responses = [
      {
        ok: true,
        json: async () => ({
          assets: [{ name: 'WinSW-x64.exe', browser_download_url: 'https://example.test/winsw.exe' }],
        }),
      },
      {
        ok: true,
        arrayBuffer: async () => Uint8Array.from([1, 2, 3]).buffer,
      },
    ];
    const result = await winswTools.downloadWinsw({
      home: 'C:\\Users\\alice',
      arch: 'x64',
      wsl: true,
      fetchImpl: async () => responses.shift(),
      mkdirSyncImpl: (path) => filesystemOps.push({ op: 'mkdir', path }),
      writeFileSyncImpl: (path) => filesystemOps.push({ op: 'write', path }),
      chmodSyncImpl: (path) => filesystemOps.push({ op: 'chmod', path }),
    });

    assert.equal(result.path, 'C:\\Users\\alice\\.myelin\\bin\\winsw.exe');
    assert.equal(result.filesystemPath, '/mnt/c/Users/alice/.myelin/bin/winsw.exe');
    assert.ok(filesystemOps.every(({ path }) => path.startsWith('/mnt/c/')));
  });
});

describe('Headroom version parsing', () => {
  it('parses version from headroom --version output', () => {
    const v = parseHeadroomVersion('headroom 1.2.3');
    assert.equal(v, '1.2.3');
  });
  it('parses version from headroom-ai style', () => {
    const v = parseHeadroomVersion('headroom-ai 1.0.0');
    assert.equal(v, '1.0.0');
  });
});

describe('headroomHealthUrl', () => {
  it('constructs URL from port', () => {
    assert.equal(headroomHealthUrl(8787), 'http://127.0.0.1:8787/health');
  });
  it('uses default 8787', () => {
    assert.equal(headroomHealthUrl(), 'http://127.0.0.1:8787/health');
  });
});

describe('writeManagedLauncher', () => {
  it('writes a POSIX launcher that invokes node with the managed launcher', () => {
    const home = makeTempHome('managed-launcher-posix');
    try {
      const result = writeManagedLauncher({ home, os: 'darwin' });
      const launcher = readFileSync(result.commandPath, 'utf8');
      const launcherSource = readFileSync(result.launcherPath, 'utf8');
      const repoEntrypoint = join(process.cwd(), 'src', 'cli', 'index.mjs');

      assert.equal(result.commandPath, join(home, '.myelin', 'bin', 'myelin'));
      assert.equal(result.launcherPath, join(home, '.myelin', 'bin', 'myelin-launcher.mjs'));
      assert.ok(launcher.includes('node'));
      assert.ok(launcher.includes('myelin-launcher.mjs'));
      assert.ok(launcherSource.includes("current.json"));
      assert.ok(launcherSource.includes('spawnSync(process.execPath'));
      assert.ok(!launcher.includes(repoEntrypoint));
      assert.ok(!launcher.includes('npm link'));
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('bakes the absolute node binary into the POSIX shim (no bare node)', () => {
    const home = makeTempHome('managed-launcher-posix-nodebin');
    try {
      const nodeBin = '/opt/nvm/versions/node/v20.11.0/bin/node';
      const result = writeManagedLauncher({ home, os: 'darwin', nodeBin });
      const launcher = readFileSync(result.commandPath, 'utf8');

      assert.ok(launcher.includes(nodeBin), `shim should embed ${nodeBin}: ${launcher}`);
      assert.ok(!/(?:^|\n)\s*exec\s+node\s/m.test(launcher), `shim must not exec bare node: ${launcher}`);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('defaults the POSIX shim node path to process.execPath (absolute)', () => {
    const home = makeTempHome('managed-launcher-posix-execpath');
    try {
      const result = writeManagedLauncher({ home, os: 'darwin' });
      const launcher = readFileSync(result.commandPath, 'utf8');

      assert.ok(launcher.includes(process.execPath), `shim should embed ${process.execPath}: ${launcher}`);
      assert.ok(process.execPath.startsWith('/'), 'process.execPath must be absolute');
      assert.ok(!/(?:^|\n)\s*exec\s+node\s/m.test(launcher));
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('bakes the absolute node binary into the Windows shim (no bare node)', () => {
    const home = makeTempHome('managed-launcher-windows-nodebin');
    try {
      const nodeBin = 'C:\\Program Files\\nodejs\\node.exe';
      const result = writeManagedLauncher({ home, os: 'windows', nodeBin });
      const launcher = readFileSync(result.commandPath, 'utf8');

      assert.ok(launcher.includes(nodeBin), `shim should embed ${nodeBin}: ${launcher}`);
      assert.ok(!/(?:^|\r?\n)node\s+"/m.test(launcher), `shim must not invoke bare node: ${launcher}`);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('writes a Windows launcher that invokes node with the managed launcher', () => {
    const home = makeTempHome('managed-launcher-windows');
    try {
      const result = writeManagedLauncher({ home, os: 'windows' });
      const launcher = readFileSync(result.commandPath, 'utf8');
      const launcherSource = readFileSync(result.launcherPath, 'utf8');
      const repoEntrypoint = join(process.cwd(), 'src', 'cli', 'index.mjs');

      assert.equal(result.commandPath, join(home, '.myelin', 'bin', 'myelin.cmd'));
      assert.equal(result.launcherPath, join(home, '.myelin', 'bin', 'myelin-launcher.mjs'));
      assert.ok(launcher.includes('node'));
      assert.ok(launcher.includes('myelin-launcher.mjs'));
      assert.ok(launcherSource.includes("current.json"));
      assert.ok(launcherSource.includes('spawnSync(process.execPath'));
      assert.ok(!launcher.includes(repoEntrypoint));
      assert.ok(!launcher.includes('npm link'));
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('linkGlobalBin managed launcher', () => {
  it('writes a stable launcher into a writable global bin dir', () => {
    const home = makeTempHome('managed-global-link');
    const prefix = join(home, 'global-prefix');
    try {
      const result = linkGlobalBin({ home, os: 'darwin', prefix });
      const expectedBinDir = posix.join(prefix, 'bin');
      const linkedLauncher = join(expectedBinDir, 'myelin');
      const launcherText = readFileSync(linkedLauncher, 'utf8');
      const repoEntrypoint = join(process.cwd(), 'src', 'cli', 'index.mjs');

      assert.equal(result.linked, true);
      assert.equal(result.binDir, expectedBinDir);
      assert.equal(result.commandPath, linkedLauncher);
      assert.equal(result.launcherPath, join(home, '.myelin', 'bin', 'myelin-launcher.mjs'));
      assert.ok(launcherText.includes('myelin-launcher.mjs'));
      assert.ok(!launcherText.includes(repoEntrypoint));
      assert.ok(!launcherText.includes('npm link'));
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('links a shim that invokes an absolute node path, not bare node', () => {
    const home = makeTempHome('managed-global-link-nodebin');
    const prefix = join(home, 'global-prefix');
    try {
      const result = linkGlobalBin({ home, os: 'darwin', prefix });
      const launcherText = readFileSync(result.commandPath, 'utf8');

      assert.equal(result.linked, true);
      assert.ok(launcherText.includes(process.execPath), `linked shim should embed ${process.execPath}: ${launcherText}`);
      assert.ok(!/(?:^|\n)\s*exec\s+node\s/m.test(launcherText), `linked shim must not exec bare node: ${launcherText}`);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('falls back to ~/.myelin/bin when the global prefix is not writable', { skip: process.platform === 'win32' }, () => {
    const home = makeTempHome('managed-global-fallback');
    const prefix = join(home, 'readonly-prefix');
    const binDir = join(prefix, 'bin');
    mkdirSync(binDir, { recursive: true });
    chmodSync(binDir, 0o555);
    try {
      const result = linkGlobalBin({ home, os: 'darwin', prefix });

      assert.equal(result.linked, false);
      assert.ok(result.reason.includes('no write access'));
      assert.equal(result.binDir, join(home, '.myelin', 'bin'));
      assert.equal(result.commandPath, join(home, '.myelin', 'bin', 'myelin'));
      assert.ok(existsSync(result.commandPath));
    } finally {
      chmodSync(binDir, 0o755);
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('detectRtkHookArtifacts', () => {
  const testRoot = join(process.cwd(), '.test-artifacts', `rtk-hooks-${process.pid}`);

  const makeHome = (name) => {
    const home = join(testRoot, name);
    rmSync(home, { recursive: true, force: true });
    mkdirSync(home, { recursive: true });
    return home;
  };

  after(() => {
    rmSync(testRoot, { recursive: true, force: true });
  });

  it('detects Claude hook wiring', () => {
    const home = makeHome('claude-ok');
    mkdirSync(join(home, '.claude'), { recursive: true });
    writeFileSync(join(home, '.claude', 'CLAUDE.md'), '# Notes\n\n@RTK.md\n');
    writeFileSync(join(home, '.claude', 'RTK.md'), '# RTK\n');
    writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify({
      hooks: {
        PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'rtk hook claude' }] }],
      },
    }, null, 2));

    const state = detectRtkHookArtifacts({ home });
    assert.equal(state.claude.relevant, true);
    assert.equal(state.claude.ok, true);
    assert.equal(state.claude.detail, 'hook + RTK.md + @RTK.md present');
  });

  it('detects Copilot hook wiring', () => {
    const home = makeHome('copilot-ok');
    mkdirSync(join(home, '.copilot', 'hooks'), { recursive: true });
    writeFileSync(join(home, '.copilot', 'mcp-config.json'), JSON.stringify({ mcpServers: {} }, null, 2));
    writeFileSync(join(home, '.copilot', 'copilot-instructions.md'), '<!-- rtk-instructions v2 -->\n# RTK\n');
    writeFileSync(join(home, '.copilot', 'hooks', 'rtk-rewrite.json'),
      JSON.stringify(buildGuardedRtkCopilotHook({ nodePath: '/usr/bin/node', repoRoot: '/repo/' }), null, 2));

    const state = detectRtkHookArtifacts({ home });
    assert.equal(state.copilot.relevant, true);
    assert.equal(state.copilot.ok, true);
    assert.equal(state.copilot.hookUnsafe, false);
    assert.equal(state.copilot.detail, 'fail-open guarded hook + copilot-instructions.md present');
  });

  it('flags a raw `rtk hook copilot` hook as UNSAFE (fail-closed)', () => {
    const home = makeHome('copilot-unsafe');
    mkdirSync(join(home, '.copilot', 'hooks'), { recursive: true });
    writeFileSync(join(home, '.copilot', 'mcp-config.json'), JSON.stringify({ mcpServers: {} }, null, 2));
    writeFileSync(join(home, '.copilot', 'copilot-instructions.md'), '<!-- rtk-instructions v2 -->\n# RTK\n');
    // The exact shape `rtk init --copilot` generates — the one that bricked Windows.
    writeFileSync(join(home, '.copilot', 'hooks', 'rtk-rewrite.json'), JSON.stringify({
      version: 1,
      hooks: {
        PreToolUse: [{ type: 'command', command: 'rtk hook copilot' }],
        preToolUse: [{ type: 'command', bash: 'rtk hook copilot', powershell: 'rtk hook copilot' }],
      },
    }, null, 2));

    const state = detectRtkHookArtifacts({ home });
    assert.equal(state.copilot.hookUnsafe, true);
    assert.equal(state.copilot.ok, false);
    assert.match(state.copilot.detail, /UNSAFE raw .rtk hook copilot/);
  });

  it('reports missing RTK artifacts clearly', () => {
    const home = makeHome('claude-missing');
    mkdirSync(join(home, '.claude'), { recursive: true });
    writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify({ env: {} }, null, 2));

    const state = detectRtkHookArtifacts({ home });
    assert.equal(state.claude.ok, false);
    assert.match(state.claude.detail, /settings\.json hook missing/);
    assert.match(state.claude.detail, /RTK\.md missing/);
    assert.match(state.claude.detail, /CLAUDE\.md missing @RTK\.md/);
  });

  it('reports unreadable hook files', () => {
    const home = makeHome('copilot-bad-json');
    mkdirSync(join(home, '.copilot', 'hooks'), { recursive: true });
    writeFileSync(join(home, '.copilot', 'mcp-config.json'), JSON.stringify({ mcpServers: {} }, null, 2));
    writeFileSync(join(home, '.copilot', 'copilot-instructions.md'), '<!-- rtk-instructions v2 -->\n# RTK\n');
    writeFileSync(join(home, '.copilot', 'hooks', 'rtk-rewrite.json'), '{ not-json');

    const state = detectRtkHookArtifacts({ home });
    assert.equal(state.copilot.ok, false);
    assert.match(state.copilot.detail, /hook file unreadable/);
  });
});
