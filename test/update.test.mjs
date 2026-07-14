import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  _stopForUpgrade,
  checkStaleConfigKeys,
  runManagedUpdate,
  runUpdate,
} from '../src/cli/update.mjs';
import { writeCurrentRelease } from '../src/runtime/release-store.mjs';
import { resolveManagedRuntime, writeManagedRuntimeBridge } from '../src/install.mjs';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const binPath = fileURLToPath(new URL('../bin/myelin', import.meta.url));

const PYTHON = process.platform === 'win32' ? 'python' : 'python3';

function makeTempDir() {
  return mkdtempSync(join(homedir(), '.tokenstack-update-test-'));
}

function captureConsole() {
  const logs = [];
  const warns = [];
  return {
    logs,
    warns,
    log: (message = '') => logs.push(message),
    warn: (message = '') => warns.push(message),
  };
}

describe('_stopForUpgrade', () => {
  it('calls powershell Stop-Process for headroom on windows', () => {
    const calls = [];
    const stub = (cmd) => calls.push(cmd);

    _stopForUpgrade('headroom', stub);

    assert.ok(calls.length === 1);
    assert.ok(calls[0].includes('headroom'));
    assert.ok(calls[0].includes('Stop-Process'));
  });

  it('calls Stop-Process for serena-agent', () => {
    const calls = [];

    _stopForUpgrade('serena', cmd => calls.push(cmd));

    assert.ok(calls[0].includes('serena-agent'));
  });

  it('no-ops for unknown tool name', () => {
    const calls = [];

    _stopForUpgrade('uv', cmd => calls.push(cmd));

    assert.strictEqual(calls.length, 0);
  });

  it('swallows errors from execSync', () => {
    assert.doesNotThrow(() => _stopForUpgrade('headroom', () => { throw new Error('ps failed'); }));
  });
});

describe('CLI update commands', () => {
  it('documents --download-only and removes update --force from help output', () => {
    const selfHelp = spawnSync(process.execPath, [binPath, 'self', '--help'], {
      cwd: repoRoot,
      encoding: 'utf8',
    });
    const updateHelp = spawnSync(process.execPath, [binPath, 'update', '--help'], {
      cwd: repoRoot,
      encoding: 'utf8',
    });

    assert.equal(selfHelp.status, 0);
    assert.match(selfHelp.stdout, /\bupdate\b/);
    assert.equal(updateHelp.status, 0);
    assert.match(updateHelp.stdout, /--check/);
    assert.match(updateHelp.stdout, /--download-only/);
    assert.ok(!updateHelp.stdout.includes('--force'));
  });

  it('exits nonzero and clearly errors when --check and --download-only are combined (M2)', () => {
    const result = spawnSync(process.execPath, [binPath, 'update', '--check', '--download-only'], {
      cwd: repoRoot,
      encoding: 'utf8',
    });

    assert.equal(result.status, 1);
    assert.match(result.stderr, /mutually exclusive/i);
  });

  it('exits nonzero with the migration message for update --self', () => {
    const result = spawnSync(process.execPath, [binPath, 'update', '--self'], {
      cwd: repoRoot,
      encoding: 'utf8',
    });

    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.equal(
      result.stderr.trim(),
      '`myelin update --self` is deprecated; run `myelin update`.',
    );
  });

  it('exits nonzero with the migration message for the deprecated self update', () => {
    const result = spawnSync(process.execPath, [binPath, 'self', 'update'], {
      cwd: repoRoot,
      encoding: 'utf8',
    });

    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.equal(
      result.stderr.trim(),
      '`myelin self update` is deprecated; run `myelin update`.',
    );
  });
});

describe('runManagedUpdate', () => {
  function orchestrationDeps(calls, overrides = {}) {
    return {
      home: '/home/alice',
      os: 'darwin',
      repoUrl: 'https://github.com/example/myelin',
      env: {},
      log: () => {},
      warn: () => {},
      stageMainRuntimeFn(options) {
        calls.push(['stage', { activate: options.activate }]);
        return {
          releaseId: 'main-abcdef123456',
          runtimeRoot: '/home/alice/.myelin/releases/main-abcdef123456',
          reused: false,
        };
      },
      writeManagedLauncherFn() {
        calls.push(['launcher']);
        return { commandPath: '/home/alice/.myelin/bin/myelin' };
      },
      runInstallerFn(options) {
        calls.push(['installer', options.args]);
        return { status: 0 };
      },
      checkStaleConfigKeysFn() {
        calls.push(['stale-config']);
        return { exists: true, staleKeys: [] };
      },
      runToolUpdatesFn() {
        calls.push(['tool-updates']);
      },
      runRestartFn() {
        calls.push(['restart']);
      },
      ...overrides,
    };
  }

  it('stages, activates, integrates, reports stale config, updates tools, then restarts', async () => {
    const calls = [];

    const result = await runManagedUpdate({}, orchestrationDeps(calls));

    assert.deepEqual(calls, [
      ['stage', { activate: true }],
      ['launcher'],
      ['installer', ['--yes']],
      ['stale-config'],
      ['tool-updates'],
      ['restart'],
    ]);
    assert.equal(result.status, 'updated');
    assert.equal(result.downloadOnly, false);
    assert.equal(result.releaseId, 'main-abcdef123456');
    assert.equal(result.runtimeRoot, '/home/alice/.myelin/releases/main-abcdef123456');
    assert.deepEqual(result.staleKeys, []);
  });

  it('forwards the resolved managed root to the staged installer as MYELIN_DIR', async () => {
    const calls = [];
    let installerEnv;

    await runManagedUpdate({}, orchestrationDeps(calls, {
      env: { MYELIN_DIR: '/custom/mroot', PATH: '/usr/bin' },
      rootDir: '/custom/mroot',
      runInstallerFn(options) {
        calls.push(['installer', options.args]);
        installerEnv = options.env;
        return { status: 0 };
      },
    }));

    assert.equal(installerEnv.MYELIN_DIR, '/custom/mroot');
    assert.equal(installerEnv.PATH, '/usr/bin');
  });

  it('download-only stages a non-activating candidate and skips every later step', async () => {
    const calls = [];

    const result = await runManagedUpdate({ downloadOnly: true }, orchestrationDeps(calls));

    assert.deepEqual(calls, [['stage', { activate: false }]]);
    assert.equal(result.status, 'downloaded');
    assert.equal(result.downloadOnly, true);
    assert.equal(result.releaseId, 'main-abcdef123456');
  });

  it('check runs only the external-tool preview and never stages or restarts', async () => {
    const calls = [];

    const result = await runManagedUpdate({ check: true }, orchestrationDeps(calls, {
      runToolUpdatesFn(options) {
        calls.push(['tool-updates', { check: options.check }]);
      },
    }));

    assert.deepEqual(calls, [['tool-updates', { check: true }]]);
    assert.equal(result.status, 'checked');
  });

  it('returns a failed status without rolling back the activated pointer on installer failure', async () => {
    const calls = [];

    const result = await runManagedUpdate({}, orchestrationDeps(calls, {
      runInstallerFn(options) {
        calls.push(['installer', options.args]);
        return { status: 7 };
      },
    }));

    // Staged + activated + launcher written, installer ran and failed; no
    // stale-config/tool-updates/restart, and the pointer is left in place.
    assert.deepEqual(calls, [
      ['stage', { activate: true }],
      ['launcher'],
      ['installer', ['--yes']],
    ]);
    assert.equal(result.status, 'failed');
    assert.equal(result.installerStatus, 7);
    assert.equal(result.releaseId, 'main-abcdef123456');
  });

  // I1: a DEFAULT install must NOT forward MYELIN_DIR to the staged installer.
  // resolveMyelinRoot never returns blank, so unconditionally forwarding it made
  // the child installer see MYELIN_DIR=<home>/.myelin and mistake a default
  // install for a relocation — rewriting ~/.zshrc to a hardcoded absolute path
  // on every update. With no rootDir/MYELIN_DIR, the child env carries none.
  it('does not forward MYELIN_DIR to the installer on a default install', async () => {
    const calls = [];
    let installerEnv;

    await runManagedUpdate({}, orchestrationDeps(calls, {
      env: { PATH: '/usr/bin' },
      runInstallerFn(options) {
        calls.push(['installer', options.args]);
        installerEnv = options.env;
        return { status: 0 };
      },
    }));

    assert.equal('MYELIN_DIR' in installerEnv, false);
    assert.equal(installerEnv.PATH, '/usr/bin');
  });

  it('does not forward MYELIN_DIR when MYELIN_DIR is set to the default root', async () => {
    const calls = [];
    let installerEnv;

    await runManagedUpdate({}, orchestrationDeps(calls, {
      env: { MYELIN_DIR: '/home/alice/.myelin', PATH: '/usr/bin' },
      runInstallerFn(options) {
        calls.push(['installer', options.args]);
        installerEnv = options.env;
        return { status: 0 };
      },
    }));

    // env is spread verbatim (so the ambient MYELIN_DIR still passes through),
    // but the update MUST NOT inject/normalize a default root as a relocation.
    assert.equal(installerEnv.MYELIN_DIR, '/home/alice/.myelin');
    assert.equal(installerEnv.PATH, '/usr/bin');
  });

  // M2: `--check` and `--download-only` are mutually exclusive — `--check` only
  // previews external-tool updates (no staging) while `--download-only` stages a
  // candidate, so combining them is a clear error rather than a silent override.
  it('rejects --check combined with --download-only as mutually exclusive', async () => {
    const calls = [];

    await assert.rejects(
      runManagedUpdate({ check: true, downloadOnly: true }, orchestrationDeps(calls)),
      /mutually exclusive/i,
    );
    // Nothing ran: not the tool preview, not staging.
    assert.deepEqual(calls, []);
  });
});

describe('runUpdate', () => {
  it('keeps --check available without requiring a git checkout', async () => {
    const consoleCapture = captureConsole();
    const execCalls = [];

    await runUpdate(
      { check: true },
      {
        os: 'darwin',
        detectAllFn: async () => ({
          uv: { installed: true, version: '0.5.0' },
          rtk: { installed: false, version: null },
        }),
        execSyncFn(command) {
          execCalls.push(command);
          throw new Error(`unexpected execSync: ${command}`);
        },
        log: consoleCapture.log,
      },
    );

    assert.deepEqual(execCalls, []);
    assert.match(consoleCapture.logs.join('\n'), /Myelin Update \(dry-run\)/);
    assert.match(consoleCapture.logs.join('\n'), /Run without --check to apply updates\./);
  });

  it('headroom upgrade targets the managed venv, honoring a relocated MYELIN_DIR', async () => {
    const consoleCapture = captureConsole();

    await runUpdate(
      { check: true },
      {
        os: 'darwin',
        home: '/home/alice',
        env: { MYELIN_DIR: '/custom/mroot' },
        detectAllFn: async () => ({ headroom: { installed: true, version: '1.0.0' } }),
        execSyncFn(command) { throw new Error(`unexpected execSync: ${command}`); },
        log: consoleCapture.log,
      },
    );

    const out = consoleCapture.logs.join('\n');
    assert.match(out, /--python "\/custom\/mroot\/venv" --upgrade "headroom-ai\[all\]"/);
    assert.ok(!out.includes('/.myelin/venv'), out);
  });

  it('headroom upgrade defaults the managed venv to <home>/.myelin/venv when MYELIN_DIR is unset', async () => {
    const consoleCapture = captureConsole();

    await runUpdate(
      { check: true },
      {
        os: 'darwin',
        home: '/home/alice',
        env: {},
        detectAllFn: async () => ({ headroom: { installed: true, version: '1.0.0' } }),
        execSyncFn(command) { throw new Error(`unexpected execSync: ${command}`); },
        log: consoleCapture.log,
      },
    );

    assert.match(consoleCapture.logs.join('\n'), /--python "\/home\/alice\/\.myelin\/venv"/);
  });
});

describe('installer runtime path safety', () => {
  it('resolves the stable launcher and selected runtime from managed home', () => {
    const home = makeTempDir();
    try {
      const currentRelease = writeCurrentRelease({ home, releaseId: 'main-abcdef1' });
      const managedRuntime = resolveManagedRuntime({ home, os: 'darwin' });

      assert.deepEqual(managedRuntime, {
        runtimeRoot: currentRelease.runtimeRoot,
        launcherPath: join(home, '.myelin', 'bin', 'myelin-launcher.mjs'),
        commandPath: join(home, '.myelin', 'bin', 'myelin'),
      });
      assert.ok(!managedRuntime.runtimeRoot.includes('/.myelin/repo'));
      assert.ok(!managedRuntime.commandPath.includes('/.myelin/repo'));
      assert.ok(!managedRuntime.runtimeRoot.startsWith(repoRoot));
      assert.ok(!managedRuntime.commandPath.startsWith(repoRoot));
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('bootstraps the managed runtime when current.json is missing', () => {
    const home = makeTempDir();
    const calls = [];
    try {
      const managedRuntime = resolveManagedRuntime({
        home,
        os: 'darwin',
        stageMainRuntimeFn({ home: stageHome, repoUrl }) {
          calls.push({ home: stageHome, repoUrl });
          writeCurrentRelease({ home: stageHome, releaseId: 'main-feedface1234' });
        },
        repoUrl: 'https://github.com/example/myelin',
      });

      assert.deepEqual(calls, [{ home, repoUrl: 'https://github.com/example/myelin' }]);
      assert.equal(managedRuntime.runtimeRoot, join(home, '.myelin', 'releases', 'main-feedface1234'));
      assert.equal(managedRuntime.commandPath, join(home, '.myelin', 'bin', 'myelin'));
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('writes stable bridge scripts that resolve current.json at runtime', () => {
    const home = makeTempDir();
    try {
      const bridge = writeManagedRuntimeBridge({ home });
      const cliBridge = readFileSync(bridge.cliPath, 'utf8');
      const mitmBridge = readFileSync(bridge.mitmAddonPath, 'utf8');
      const gitExtraBridge = readFileSync(bridge.gitExtraPath, 'utf8');

      assert.equal(bridge.root, join(home, '.myelin', 'runtime-bridge'));
      assert.ok(cliBridge.includes('current.json'));
      assert.ok(mitmBridge.includes('current.json'));
      assert.ok(gitExtraBridge.includes('current.json'));
      assert.ok(cliBridge.includes("const runtimeRoot = join(releasesDir, parsed.releaseId);"));
      assert.ok(mitmBridge.includes("RELEASE_ID_RE = re.compile"));
      assert.ok(gitExtraBridge.includes("normalized_runtime_root(current.get('runtimeRoot')) != normalized_runtime_root(runtime_root)"));
      assert.ok(!cliBridge.includes(repoRoot));
      assert.ok(!mitmBridge.includes(repoRoot));
      assert.ok(!gitExtraBridge.includes(repoRoot));
      assert.ok(!cliBridge.includes('/.myelin/repo'));
      assert.ok(!mitmBridge.includes('/.myelin/repo'));
      assert.ok(!gitExtraBridge.includes('/.myelin/repo'));
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('generates bridges that read MYELIN_DIR on every invocation', () => {
    const home = makeTempDir();
    try {
      const bridge = writeManagedRuntimeBridge({ home });
      const cliBridge = readFileSync(bridge.cliPath, 'utf8');
      const mitmBridge = readFileSync(bridge.mitmAddonPath, 'utf8');
      const gitExtraBridge = readFileSync(bridge.gitExtraPath, 'utf8');

      assert.ok(cliBridge.includes('process.env.MYELIN_DIR'));
      assert.ok(mitmBridge.includes("os.environ.get('MYELIN_DIR')"));
      assert.ok(gitExtraBridge.includes("os.environ.get('MYELIN_DIR')"));
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('generates bridges that accept equivalent WSL-mounted and Windows runtime roots', () => {
    const home = makeTempDir();
    try {
      const bridge = writeManagedRuntimeBridge({ home });
      const cliBridge = readFileSync(bridge.cliPath, 'utf8');
      const mitmBridge = readFileSync(bridge.mitmAddonPath, 'utf8');
      const gitExtraBridge = readFileSync(bridge.gitExtraPath, 'utf8');

      assert.ok(cliBridge.includes('normalizedRuntimeRoot'));
      assert.ok(cliBridge.includes('normalizedRuntimeRoot(parsed.runtimeRoot)'));
      assert.ok(cliBridge.includes('isWindowsDriveRoot'));
      assert.ok(mitmBridge.includes('normalized_runtime_root'));
      assert.ok(gitExtraBridge.includes('normalized_runtime_root'));
      assert.ok(mitmBridge.includes('is_windows_drive_root'));
      assert.ok(gitExtraBridge.includes('is_windows_drive_root'));
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('generated bridges treat a blank/whitespace MYELIN_DIR as absent (matching resolveMyelinRoot)', () => {
    const home = makeTempDir();
    try {
      const bridge = writeManagedRuntimeBridge({ home });
      const cliBridge = readFileSync(bridge.cliPath, 'utf8');
      const mitmBridge = readFileSync(bridge.mitmAddonPath, 'utf8');
      const gitExtraBridge = readFileSync(bridge.gitExtraPath, 'utf8');

      // JS bridge: trim() guard, never a bare `|| join(...)` that keeps blanks
      assert.ok(cliBridge.includes('.trim()'));
      assert.ok(!cliBridge.includes('process.env.MYELIN_DIR || join'));
      // Python bridges: strip() guard, never a bare `or (...)` that keeps blanks
      assert.ok(mitmBridge.includes('.strip()'));
      assert.ok(!mitmBridge.includes("os.environ.get('MYELIN_DIR') or ("));
      assert.ok(gitExtraBridge.includes('.strip()'));
      assert.ok(!gitExtraBridge.includes("os.environ.get('MYELIN_DIR') or ("));
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('writes bridge scripts beneath a supplied root', () => {
    const home = makeTempDir();
    const rootDir = join(home, 'managed-root');
    try {
      const bridge = writeManagedRuntimeBridge({ home, rootDir });
      assert.equal(bridge.root, join(rootDir, 'runtime-bridge'));
      assert.equal(bridge.cliPath, join(rootDir, 'runtime-bridge', 'src', 'cli', 'index.mjs'));
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('keeps Windows managed runtime bridge paths separator-safe', () => {
    const rootDir = 'D:\\managed\\myelin';
    const directories = [];
    const bridge = writeManagedRuntimeBridge({
      home: '/home/alice',
      rootDir,
      mkdirSyncFn(path) {
        directories.push(path);
      },
      writeFileSyncFn() {},
    });

    assert.deepEqual(bridge, {
      root: 'D:\\managed\\myelin\\runtime-bridge',
      cliPath: 'D:\\managed\\myelin\\runtime-bridge\\src\\cli\\index.mjs',
      mitmAddonPath: 'D:\\managed\\myelin\\runtime-bridge\\src\\mitm\\copilot_addon.py',
      gitExtraPath: 'D:\\managed\\myelin\\runtime-bridge\\src\\mcp\\git-extra.py',
    });
    assert.deepEqual(directories, [
      'D:\\managed\\myelin\\runtime-bridge\\src\\cli',
      'D:\\managed\\myelin\\runtime-bridge\\src\\mitm',
      'D:\\managed\\myelin\\runtime-bridge\\src\\mcp',
    ]);
  });

  it('resolves the managed runtime beneath a supplied root', () => {
    const home = makeTempDir();
    const rootDir = join(home, 'managed-root');
    try {
      const currentRelease = writeCurrentRelease({ home, rootDir, releaseId: 'main-abcdef1' });
      const managedRuntime = resolveManagedRuntime({ home, rootDir, os: 'darwin' });

      assert.equal(managedRuntime.runtimeRoot, currentRelease.runtimeRoot);
      assert.equal(managedRuntime.launcherPath, join(rootDir, 'bin', 'myelin-launcher.mjs'));
      assert.equal(managedRuntime.commandPath, join(rootDir, 'bin', 'myelin'));
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('keeps a Windows managed runtime command path separator-safe', () => {
    const rootDir = 'D:\\managed\\myelin';
    const managedRuntime = resolveManagedRuntime({
      home: '/home/alice',
      rootDir,
      os: 'windows',
      readCurrentReleaseFn: () => ({
        runtimeRoot: 'D:\\managed\\myelin\\releases\\main-abcdef1',
      }),
      runtimePathsFn: () => ({
        root: rootDir,
        launcherPath: 'D:\\managed\\myelin\\bin\\myelin-launcher.mjs',
      }),
    });

    assert.deepEqual(managedRuntime, {
      runtimeRoot: 'D:\\managed\\myelin\\releases\\main-abcdef1',
      launcherPath: 'D:\\managed\\myelin\\bin\\myelin-launcher.mjs',
      commandPath: 'D:\\managed\\myelin\\bin\\myelin.cmd',
    });
  });

  it('does not generate shell aliases from a checkout path', () => {
    const installSource = readFileSync(fileURLToPath(new URL('../src/install.mjs', import.meta.url)), 'utf8');

    assert.ok(!installSource.includes('alias myelin="node '));
    assert.ok(!installSource.includes('function global:myelin { node "'));
    assert.ok(installSource.includes('managedRuntime.commandPath'));
    assert.ok(installSource.includes('args: [runtimeBridge.gitExtraPath]'));
    assert.ok(installSource.includes('repoRoot: runtimeBridge.root'));
    assert.ok(installSource.includes('return runtimeBridgePaths(home).mitmAddonPath;'));
  });

  it('derives the installer CA bundle path from shared managed paths (honors MYELIN_DIR)', () => {
    const installSource = readFileSync(fileURLToPath(new URL('../src/install.mjs', import.meta.url)), 'utf8');

    // The rebuilt bundle path must come from managedPaths(...).caBundlePath,
    // not a hardcoded join(home, '.myelin', 'ca-bundle.pem').
    assert.ok(installSource.includes('caBundlePath: ourBundle'));
    assert.ok(!installSource.includes("join(home, '.myelin', 'ca-bundle.pem')"));
  });

  it('does not keep repo-root fallbacks in the global bin linker', () => {
    const npmlinkSource = readFileSync(fileURLToPath(new URL('../src/service/npmlink.mjs', import.meta.url)), 'utf8');

    assert.ok(!npmlinkSource.includes('repoRoot'));
  });
});

describe('checkStaleConfigKeys', () => {
  it('prints an informational note when stale config keys exist', async () => {
    const repoDir = makeTempDir();
    try {
      const configPath = join(repoDir, 'config.yaml');
      writeFileSync(configPath, 'conversation_memory:\n  mem0: true\nproxy:\n  headroom:\n    port: 9999\n', 'utf8');
      const consoleCapture = captureConsole();

      const result = await checkStaleConfigKeys({ configPath, warn: consoleCapture.warn });

      assert.deepEqual(result.staleKeys, ['conversation_memory.mem0']);
      assert.deepEqual(consoleCapture.warns, [
        `ℹ Your ${configPath} has 1 stale config key(s) no longer used by this version.`,
        '  Run: myelin config prune --dry-run to preview, or myelin config prune to clean them up.',
      ]);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it('stays quiet when the config is clean or missing', async () => {
    const repoDir = makeTempDir();
    try {
      const cleanPath = join(repoDir, 'clean.yaml');
      const missingPath = join(repoDir, 'missing.yaml');
      writeFileSync(cleanPath, 'proxy:\n  headroom:\n    port: 9999\n', 'utf8');

      const cleanCapture = captureConsole();
      const cleanResult = await checkStaleConfigKeys({ configPath: cleanPath, warn: cleanCapture.warn });
      assert.deepEqual(cleanResult.staleKeys, []);
      assert.deepEqual(cleanCapture.warns, []);

      const missingCapture = captureConsole();
      const missingResult = await checkStaleConfigKeys({ configPath: missingPath, warn: missingCapture.warn });
      assert.equal(missingResult.exists, false);
      assert.deepEqual(missingCapture.warns, []);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });
});

describe('bridge behavioral execution', () => {
  const releaseIdA = 'main-aaaaaaa1111111';
  const releaseIdB = 'main-bbbbbbb2222222';

  function bridgeEnv(home) {
    return { ...process.env, HOME: home, USERPROFILE: home };
  }

  function normalizePythonStdout(stdout) {
    return stdout.replace(/\r\n/g, '\n');
  }

  function writeBridgeTarget({ home, releaseId, relativePath, source }) {
    const targetPath = join(home, '.myelin', 'releases', releaseId, relativePath);
    mkdirSync(dirname(targetPath), { recursive: true });
    writeFileSync(targetPath, source, 'utf8');
  }

  describe('CLI bridge', () => {
    it('exits 1 when current.json is absent', () => {
      const home = makeTempDir();
      try {
        const bridge = writeManagedRuntimeBridge({ home });
        const result = spawnSync(process.execPath, [bridge.cliPath], { env: bridgeEnv(home), encoding: 'utf8' });
        assert.equal(result.status, 1);
        assert.match(result.stderr, /no current managed runtime configured/);
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    });

    it('rejects a current.json with invalid version', () => {
      const home = makeTempDir();
      try {
        const bridge = writeManagedRuntimeBridge({ home });
        writeFileSync(
          join(home, '.myelin', 'current.json'),
          JSON.stringify({ version: 2, releaseId: 'main-abcdef1234567', runtimeRoot: join(home, '.myelin', 'releases', 'main-abcdef1234567') }),
          'utf8',
        );
        const result = spawnSync(process.execPath, [bridge.cliPath], { env: bridgeEnv(home), encoding: 'utf8' });
        assert.equal(result.status, 1);
        assert.match(result.stderr, /no current managed runtime configured/);
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    });

    it('rejects a current.json with mismatched runtimeRoot', () => {
      const home = makeTempDir();
      try {
        const bridge = writeManagedRuntimeBridge({ home });
        writeFileSync(
          join(home, '.myelin', 'current.json'),
          JSON.stringify({ version: 1, releaseId: 'main-abcdef1234567', runtimeRoot: '/different/path' }),
          'utf8',
        );
        const result = spawnSync(process.execPath, [bridge.cliPath], { env: bridgeEnv(home), encoding: 'utf8' });
        assert.equal(result.status, 1);
        assert.match(result.stderr, /no current managed runtime configured/);
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    });

    it('rereads current.json on every invocation', () => {
      const home = makeTempDir();
      try {
        const bridge = writeManagedRuntimeBridge({ home });
        writeBridgeTarget({
          home,
          releaseId: releaseIdA,
          relativePath: 'src/cli/index.mjs',
          source: "console.log('CLI-A');\n",
        });
        writeCurrentRelease({ home, releaseId: releaseIdA });
        const r1 = spawnSync(process.execPath, [bridge.cliPath], { env: bridgeEnv(home), encoding: 'utf8' });
        assert.equal(r1.status, 0);
        assert.equal(r1.stdout, 'CLI-A\n');

        writeBridgeTarget({
          home,
          releaseId: releaseIdB,
          relativePath: 'src/cli/index.mjs',
          source: "console.log('CLI-B');\n",
        });
        writeCurrentRelease({ home, releaseId: releaseIdB });
        const r2 = spawnSync(process.execPath, [bridge.cliPath], { env: bridgeEnv(home), encoding: 'utf8' });
        assert.equal(r2.status, 0);
        assert.equal(r2.stdout, 'CLI-B\n');
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    });

    it('resolves the current release from MYELIN_DIR at runtime', () => {
      const home = makeTempDir();
      const rootDir = join(home, 'managed-root');
      try {
        const bridge = writeManagedRuntimeBridge({ home });
        const targetPath = join(rootDir, 'releases', releaseIdA, 'src', 'cli', 'index.mjs');
        mkdirSync(dirname(targetPath), { recursive: true });
        writeFileSync(targetPath, "console.log('CLI-ROOTDIR');\n", 'utf8');
        writeCurrentRelease({ home, rootDir, releaseId: releaseIdA });

        const r = spawnSync(process.execPath, [bridge.cliPath], {
          env: { ...bridgeEnv(home), MYELIN_DIR: rootDir },
          encoding: 'utf8',
        });
        assert.equal(r.status, 0, `stderr: ${r.stderr}`);
        assert.equal(r.stdout, 'CLI-ROOTDIR\n');
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    });

    it('treats a blank/whitespace MYELIN_DIR as absent and falls back to home', () => {
      const home = makeTempDir();
      try {
        const bridge = writeManagedRuntimeBridge({ home });
        writeBridgeTarget({
          home,
          releaseId: releaseIdA,
          relativePath: 'src/cli/index.mjs',
          source: "console.log('CLI-HOME');\n",
        });
        writeCurrentRelease({ home, releaseId: releaseIdA });
        const r = spawnSync(process.execPath, [bridge.cliPath], {
          env: { ...bridgeEnv(home), MYELIN_DIR: '   ' },
          encoding: 'utf8',
        });
        assert.equal(r.status, 0, `stderr: ${r.stderr}`);
        assert.equal(r.stdout, 'CLI-HOME\n');
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    });
  });

  describe('MITM bridge (Python)', () => {
    it('exits 1 when current.json is absent', () => {
      const home = makeTempDir();
      try {
        const bridge = writeManagedRuntimeBridge({ home });
        const result = spawnSync(PYTHON, [bridge.mitmAddonPath], { env: bridgeEnv(home), encoding: 'utf8' });
        assert.equal(result.status, 1);
        assert.match(result.stderr, /could not read/);
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    });

    it('rejects a current.json with invalid version', () => {
      const home = makeTempDir();
      try {
        const bridge = writeManagedRuntimeBridge({ home });
        writeFileSync(
          join(home, '.myelin', 'current.json'),
          JSON.stringify({ version: 2, releaseId: 'main-abcdef1234567', runtimeRoot: join(home, '.myelin', 'releases', 'main-abcdef1234567') }),
          'utf8',
        );
        const result = spawnSync(PYTHON, [bridge.mitmAddonPath], { env: bridgeEnv(home), encoding: 'utf8' });
        assert.equal(result.status, 1);
        assert.match(result.stderr, /invalid managed runtime pointer/);
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    });

    it('rejects a current.json with mismatched runtimeRoot', () => {
      const home = makeTempDir();
      try {
        const bridge = writeManagedRuntimeBridge({ home });
        writeFileSync(
          join(home, '.myelin', 'current.json'),
          JSON.stringify({ version: 1, releaseId: 'main-abcdef1234567', runtimeRoot: '/different/path' }),
          'utf8',
        );
        const result = spawnSync(PYTHON, [bridge.mitmAddonPath], { env: bridgeEnv(home), encoding: 'utf8' });
        assert.equal(result.status, 1);
        assert.match(result.stderr, /invalid managed runtime pointer/);
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    });

    it('rereads current.json on every invocation', () => {
      const home = makeTempDir();
      try {
        const bridge = writeManagedRuntimeBridge({ home });
        writeBridgeTarget({
          home,
          releaseId: releaseIdA,
          relativePath: 'src/mitm/copilot_addon.py',
          source: "print('MITM-A')\n",
        });
        writeCurrentRelease({ home, releaseId: releaseIdA });
        const r1 = spawnSync(PYTHON, [bridge.mitmAddonPath], { env: bridgeEnv(home), encoding: 'utf8' });
        assert.equal(r1.status, 0);
        assert.equal(normalizePythonStdout(r1.stdout), 'MITM-A\n');

        writeBridgeTarget({
          home,
          releaseId: releaseIdB,
          relativePath: 'src/mitm/copilot_addon.py',
          source: "print('MITM-B')\n",
        });
        writeCurrentRelease({ home, releaseId: releaseIdB });
        const r2 = spawnSync(PYTHON, [bridge.mitmAddonPath], { env: bridgeEnv(home), encoding: 'utf8' });
        assert.equal(r2.status, 0);
        assert.equal(normalizePythonStdout(r2.stdout), 'MITM-B\n');
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    });

    it('treats a blank/whitespace MYELIN_DIR as absent and falls back to home', () => {
      const home = makeTempDir();
      try {
        const bridge = writeManagedRuntimeBridge({ home });
        writeBridgeTarget({
          home,
          releaseId: releaseIdA,
          relativePath: 'src/mitm/copilot_addon.py',
          source: "print('MITM-HOME')\n",
        });
        writeCurrentRelease({ home, releaseId: releaseIdA });
        const r = spawnSync(PYTHON, [bridge.mitmAddonPath], {
          env: { ...bridgeEnv(home), MYELIN_DIR: '  \t ' },
          encoding: 'utf8',
        });
        assert.equal(r.status, 0, `stderr: ${r.stderr}`);
        assert.equal(normalizePythonStdout(r.stdout), 'MITM-HOME\n');
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    });
  });

  describe('git-extra bridge (Python)', () => {
    it('exits 1 when current.json is absent', () => {
      const home = makeTempDir();
      try {
        const bridge = writeManagedRuntimeBridge({ home });
        const result = spawnSync(PYTHON, [bridge.gitExtraPath], { env: bridgeEnv(home), encoding: 'utf8' });
        assert.equal(result.status, 1);
        assert.match(result.stderr, /could not read/);
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    });

    it('rejects a current.json with invalid version', () => {
      const home = makeTempDir();
      try {
        const bridge = writeManagedRuntimeBridge({ home });
        writeFileSync(
          join(home, '.myelin', 'current.json'),
          JSON.stringify({ version: 2, releaseId: 'main-abcdef1234567', runtimeRoot: join(home, '.myelin', 'releases', 'main-abcdef1234567') }),
          'utf8',
        );
        const result = spawnSync(PYTHON, [bridge.gitExtraPath], { env: bridgeEnv(home), encoding: 'utf8' });
        assert.equal(result.status, 1);
        assert.match(result.stderr, /invalid managed runtime pointer/);
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    });

    it('rejects a current.json with mismatched runtimeRoot', () => {
      const home = makeTempDir();
      try {
        const bridge = writeManagedRuntimeBridge({ home });
        writeFileSync(
          join(home, '.myelin', 'current.json'),
          JSON.stringify({ version: 1, releaseId: 'main-abcdef1234567', runtimeRoot: '/different/path' }),
          'utf8',
        );
        const result = spawnSync(PYTHON, [bridge.gitExtraPath], { env: bridgeEnv(home), encoding: 'utf8' });
        assert.equal(result.status, 1);
        assert.match(result.stderr, /invalid managed runtime pointer/);
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    });

    it('rereads current.json on every invocation', () => {
      const home = makeTempDir();
      try {
        const bridge = writeManagedRuntimeBridge({ home });
        writeBridgeTarget({
          home,
          releaseId: releaseIdA,
          relativePath: 'src/mcp/git-extra.py',
          source: "print('GIT-EXTRA-A')\n",
        });
        writeCurrentRelease({ home, releaseId: releaseIdA });
        const r1 = spawnSync(PYTHON, [bridge.gitExtraPath], { env: bridgeEnv(home), encoding: 'utf8' });
        assert.equal(r1.status, 0);
        assert.equal(normalizePythonStdout(r1.stdout), 'GIT-EXTRA-A\n');

        writeBridgeTarget({
          home,
          releaseId: releaseIdB,
          relativePath: 'src/mcp/git-extra.py',
          source: "print('GIT-EXTRA-B')\n",
        });
        writeCurrentRelease({ home, releaseId: releaseIdB });
        const r2 = spawnSync(PYTHON, [bridge.gitExtraPath], { env: bridgeEnv(home), encoding: 'utf8' });
        assert.equal(r2.status, 0);
        assert.equal(normalizePythonStdout(r2.stdout), 'GIT-EXTRA-B\n');
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    });

    it('treats a blank/whitespace MYELIN_DIR as absent and falls back to home', () => {
      const home = makeTempDir();
      try {
        const bridge = writeManagedRuntimeBridge({ home });
        writeBridgeTarget({
          home,
          releaseId: releaseIdA,
          relativePath: 'src/mcp/git-extra.py',
          source: "print('GIT-EXTRA-HOME')\n",
        });
        writeCurrentRelease({ home, releaseId: releaseIdA });
        const r = spawnSync(PYTHON, [bridge.gitExtraPath], {
          env: { ...bridgeEnv(home), MYELIN_DIR: ' \t' },
          encoding: 'utf8',
        });
        assert.equal(r.status, 0, `stderr: ${r.stderr}`);
        assert.equal(normalizePythonStdout(r.stdout), 'GIT-EXTRA-HOME\n');
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    });
  });
});
