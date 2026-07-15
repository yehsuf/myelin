import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { join } from 'node:path';

import {
  createUpdateLock,
  UPDATE_LOCK_SCHEMA_VERSION,
} from '../src/update/update-orchestrator.mjs';

const temporaryRoots = [];

function makeRoot() {
  const root = fs.mkdtempSync(join(process.cwd(), '.test-task10-fixes-'));
  temporaryRoots.push(root);
  return root;
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function lockRecord({ token, pid, startedAt, heartbeatAt }) {
  return JSON.stringify({
    schemaVersion: UPDATE_LOCK_SCHEMA_VERSION,
    token,
    pid,
    startedAt,
    heartbeatAt,
  });
}

describe('Task 10 finding 1: stale reclaim marker recovery', { concurrency: false }, () => {
  it('acquires the lock past an orphaned stale reclaim marker left by a dead reclaimer', () => {
    const root = makeRoot();
    const lockPath = join(root, 'update.lock');
    const now = 10_000_000;
    const stalePrimaryPid = 4444;
    const staleReclaimPid = 5555;
    const acquirerPid = 6666;

    // Stale primary lock (dead owner, ancient heartbeat).
    fs.writeFileSync(lockPath, lockRecord({
      token: 'stale-primary-token',
      pid: stalePrimaryPid,
      startedAt: now - 1_000_000,
      heartbeatAt: now - 1_000_000,
    }));
    // Orphaned stale reclaim marker left behind by a reclaimer that died.
    fs.writeFileSync(`${lockPath}.reclaim`, lockRecord({
      token: 'stale-reclaim-token',
      pid: staleReclaimPid,
      startedAt: now - 900_000,
      heartbeatAt: now - 900_000,
    }));

    let tokenCounter = 0;
    const lock = createUpdateLock({
      now: () => now,
      pid: acquirerPid,
      isPidAlive: pid => pid === acquirerPid,
      randomToken: () => `acquirer-token-${tokenCounter++}`,
      staleAfterMs: 1_000,
    });

    const owner = lock.acquire(lockPath);

    assert.equal(owner.pid, acquirerPid);
    const persisted = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    assert.equal(persisted.pid, acquirerPid);
    assert.equal(persisted.token, owner.token);
    // The orphaned reclaim marker must be cleaned up after a successful acquire.
    assert.equal(fs.existsSync(`${lockPath}.reclaim`), false);
  });

  it('still rejects acquisition when a reclaim marker owner is alive', () => {
    const root = makeRoot();
    const lockPath = join(root, 'update.lock');
    const now = 20_000_000;

    fs.writeFileSync(lockPath, lockRecord({
      token: 'stale-primary-token',
      pid: 4444,
      startedAt: now - 1_000_000,
      heartbeatAt: now - 1_000_000,
    }));
    // Reclaim marker owned by a LIVE reclaimer (another updater mid-reclaim).
    fs.writeFileSync(`${lockPath}.reclaim`, lockRecord({
      token: 'live-reclaim-token',
      pid: 7777,
      startedAt: now - 10,
      heartbeatAt: now - 10,
    }));

    const lock = createUpdateLock({
      now: () => now,
      pid: 6666,
      isPidAlive: pid => pid === 7777, // primary dead, reclaimer alive
      randomToken: () => 'acquirer-token',
      staleAfterMs: 1_000,
    });

    assert.throws(() => lock.acquire(lockPath), /already held/i);
    // A live reclaimer's marker must be preserved.
    assert.equal(fs.existsSync(`${lockPath}.reclaim`), true);
  });
});

import {
  createUpdateDependencies,
  activateUpdate,
} from '../src/update/update-orchestrator.mjs';

function noServiceConfigSnapshot() {
  return {
    exists: true,
    bytes: Buffer.from('compression:\n  backend: disabled\n'),
    mode: 0o600,
    metadata: {},
  };
}

function stubbedTransactionOverrides(events = []) {
  // Stubs every heavy mutation boundary but intentionally leaves the default
  // requiredServices and the (absent) verify dependency untouched so the real
  // strict-health path runs for a no-service topology.
  return {
    captureSnapshot: async () => ({
      config: noServiceConfigSnapshot(),
      release: { current: '1.0.0', previous: '0.9.0' },
      components: {},
      services: {},
      supervisors: {},
    }),
    captureDesiredState: async () => ({
      config: noServiceConfigSnapshot(),
      release: { current: '1.1.0', previous: '1.0.0' },
      components: {},
      services: {},
      supervisors: {},
    }),
    describeDesiredState: async ({ desired }) => desired,
    writeJournal: async journal => events.push(`journal:${journal.phase}`),
    cleanupJournal: async () => events.push('cleanup-journal'),
    quiesceServices: async () => events.push('quiesce-services'),
    quiesceSupervisors: async () => events.push('quiesce-supervisors'),
    applyComponentPairs: async () => events.push('apply-components'),
    writeConfig: async () => events.push('write-config'),
    applyReleasePair: async () => events.push('apply-release'),
    installLauncher: async () => events.push('install-launcher'),
    runStagedApply: async () => events.push('staged-apply'),
    startServices: async () => events.push('start-services'),
    startSupervisors: async () => events.push('start-supervisors'),
    stopNewServicesAndWatchdogs: async () => events.push('stop-new'),
    restoreComponentPairs: async () => events.push('restore-components'),
    restoreReleasePair: async () => events.push('restore-release'),
    restoreConfig: async () => events.push('restore-config'),
    restoreServiceDefinitions: async () => events.push('restore-services'),
    restoreSupervisors: async () => events.push('restore-supervisors'),
    restoreServiceStatus: async () => events.push('restore-service-status'),
    restoreSupervisorStatus: async () => events.push('restore-supervisor-status'),
  };
}

describe('Task 10 finding 2: no-service topology health gate', { concurrency: false }, () => {
  it('activates a disabled-compression / disabled-mitm plan without rolling back', async () => {
    const events = [];
    const deps = createUpdateDependencies({
      home: makeRoot(),
      platform: 'linux',
      ...stubbedTransactionOverrides(events),
    });

    const plan = {
      channel: 'stable',
      backend: 'disabled',
      config: { proxy: { compression: { enabled: false }, mitm: { enabled: false } } },
      components: [],
      release: { current: '1.1.0', previous: '1.0.0' },
      desiredConfig: noServiceConfigSnapshot(),
      stagedRelease: { version: '1.1.0', directory: '/managed/releases/1.1.0' },
    };

    // The default requiredServices must resolve to no services for this config.
    assert.deepEqual(await deps.requiredServices(plan), []);
    // No verify dependency is injected for the default no-service path.
    assert.equal(typeof deps.verify, 'undefined');

    const result = await activateUpdate(plan, deps, {});

    assert.equal(result.ok, true, `expected activation, got ${result.status}: ${result.error?.message ?? ''}`);
    assert.equal(result.status, 'activated');
    assert.ok(!events.includes('restore-release'), 'must not roll back a healthy no-service update');
  });
});

import { EventEmitter } from 'node:events';
import {
  deriveInstallProfile,
  buildStagedApplyArgs,
} from '../src/update/update-orchestrator.mjs';

function fakeSpawn(record) {
  return (file, args, options) => {
    record.push({ file, args, options });
    const child = new EventEmitter();
    child.once = child.once.bind(child);
    queueMicrotask(() => child.emit('exit', 0, null));
    return child;
  };
}

describe('Task 10 finding 5: staged apply preserves install profile', { concurrency: false }, () => {
  it('derives mcp profile for a disabled compression + disabled mitm topology', () => {
    assert.equal(
      deriveInstallProfile({ proxy: { compression: { enabled: false }, mitm: { enabled: false } } }),
      'mcp',
    );
  });

  it('derives proxy profile when compression or mitm is active', () => {
    assert.equal(deriveInstallProfile({ proxy: { engine: 'headroom_lite' } }), 'proxy');
    assert.equal(
      deriveInstallProfile({ proxy: { compression: { enabled: false }, mitm: { enabled: true } } }),
      'proxy',
    );
  });

  it('always emits --update-apply and an explicit --profile in the child argv', () => {
    const args = buildStagedApplyArgs({
      installer: '/staged/src/install.mjs',
      token: 'tkn',
      directory: '/staged',
      configPath: '/home/.myelin/config.yaml',
      profile: 'mcp',
    });
    assert.ok(args.includes('--update-apply'));
    const profileIndex = args.indexOf('--profile');
    assert.ok(profileIndex >= 0);
    assert.equal(args[profileIndex + 1], 'mcp');
  });

  it('passes the preserved mcp profile through the default runStagedApply wiring', async () => {
    const record = [];
    const deps = createUpdateDependencies({
      home: makeRoot(),
      platform: 'linux',
      stagedApplySpawn: fakeSpawn(record),
    });

    await deps.runStagedApply({
      plan: { config: { proxy: { compression: { enabled: false }, mitm: { enabled: false } } } },
      stagedRelease: { version: '1.1.0', directory: '/managed/releases/1.1.0' },
      lockToken: { token: 'transaction-token' },
    });

    assert.equal(record.length, 1);
    const { args, options } = record[0];
    assert.ok(args.includes('--update-apply'), 'staged apply must run in update-apply mode');
    const profileIndex = args.indexOf('--profile');
    assert.equal(args[profileIndex + 1], 'mcp', 'must preserve the mcp topology, not default to proxy');
    assert.equal(options.env.MYELIN_UPDATE_PROFILE, 'mcp');
  });

  it('passes the proxy profile for an active compression topology', async () => {
    const record = [];
    const deps = createUpdateDependencies({
      home: makeRoot(),
      platform: 'linux',
      stagedApplySpawn: fakeSpawn(record),
    });

    await deps.runStagedApply({
      plan: { config: { proxy: { engine: 'headroom_lite' } } },
      stagedRelease: { version: '1.1.0', directory: '/managed/releases/1.1.0' },
      lockToken: { token: 'transaction-token' },
    });

    const { args } = record[0];
    assert.equal(args[args.indexOf('--profile') + 1], 'proxy');
  });
});

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ensureMitmproxy } from '../src/install.mjs';

const INSTALL_SOURCE = readFileSync(
  fileURLToPath(new URL('../src/install.mjs', import.meta.url)),
  'utf8',
);

describe('Task 10 finding 3: no global component installs during update-apply', { concurrency: false }, () => {
  it('ensureMitmproxy in detect-only mode never performs a global install', async () => {
    const execSyncCalls = [];
    const execFileSyncCalls = [];
    const result = await ensureMitmproxy('linux', {
      installIfMissing: false,
      detectMitmdumpImpl: () => null,
      execSyncImpl: (command) => { execSyncCalls.push(command); return Buffer.alloc(0); },
      execFileSyncImpl: (file, args) => { execFileSyncCalls.push({ file, args }); return Buffer.alloc(0); },
    });
    assert.equal(result, null, 'detect-only mode must not synthesize a binary');
    assert.deepEqual(execSyncCalls, [], 'detect-only must not shell out to a package manager');
    assert.deepEqual(execFileSyncCalls, [], 'detect-only must not shell out to a package manager');
  });

  it('ensureMitmproxy still installs when installIfMissing defaults to true', async () => {
    const execSyncCalls = [];
    const result = await ensureMitmproxy('linux', {
      detectMitmdumpImpl: () => null,
      execSyncImpl: (command) => { execSyncCalls.push(command); return Buffer.alloc(0); },
    });
    assert.equal(result, null);
    assert.ok(execSyncCalls.length >= 1, 'default mode preserves the auto-install behavior');
  });

  it('defines a single update-apply gate for global component installs', () => {
    assert.match(
      INSTALL_SOURCE,
      /const runGlobalComponentInstalls = !flags\['update-apply'\];/u,
    );
  });

  it('gates the package manager (uv) install behind the update-apply gate', () => {
    assert.match(
      INSTALL_SOURCE,
      /\[1\/7\][\s\S]{0,240}?if \(runGlobalComponentInstalls\)[\s\S]{0,120}?await ensureUv\(\)/u,
    );
  });

  it('gates the code-discovery tool installs behind the update-apply gate', () => {
    assert.match(
      INSTALL_SOURCE,
      /\[2\/7\][\s\S]{0,240}?if \(!?runGlobalComponentInstalls\)/u,
    );
  });

  it('gates the proxy backbone component installs behind the update-apply gate', () => {
    assert.match(
      INSTALL_SOURCE,
      /!tools\.headroom\.installed && runGlobalComponentInstalls/u,
    );
    assert.match(
      INSTALL_SOURCE,
      /!tools\.rtk\.installed && runGlobalComponentInstalls/u,
    );
  });

  it('threads the update-apply gate into every ensureMitmproxy call site', () => {
    const callSites = INSTALL_SOURCE.match(/await ensureMitmproxy\(os, \{[\s\S]*?\}\)/gu) ?? [];
    assert.ok(callSites.length >= 1, 'expected the mitmproxy install call site');
    for (const site of callSites) {
      assert.match(site, /installIfMissing: runGlobalComponentInstalls/u);
    }
  });
});

import {
  stageComponent,
  isStageComplete,
} from '../src/update/component-installers.mjs';
import { COMPONENTS } from '../src/update/component-manifest.mjs';
import { componentVersionDir } from '../src/update/version-store.mjs';
import { updatePaths } from '../src/update/update-orchestrator.mjs';

function materializeSembleVenv(dest) {
  fs.mkdirSync(join(dest, 'bin'), { recursive: true });
  fs.writeFileSync(join(dest, 'bin', 'semble'), 'venv-binary');
}

function stageSemble(root, { exec } = {}) {
  const dest = componentVersionDir(root, 'semble', COMPONENTS.semble.version);
  return stageComponent({
    name: 'semble',
    component: COMPONENTS.semble,
    root,
    platform: 'linux',
    fs,
    exec: exec ?? (() => materializeSembleVenv(dest)),
  });
}

describe('Task 10 finding 4: partial component stage never activates', { concurrency: false }, () => {
  it('writes a durable completion marker only after a successful stage', () => {
    const root = makeRoot();
    const dest = componentVersionDir(root, 'semble', COMPONENTS.semble.version);
    assert.equal(isStageComplete(dest, { fs, platform: 'linux' }), false);
    stageSemble(root);
    assert.equal(isStageComplete(dest, { fs, platform: 'linux' }), true);
  });

  it('does not treat an interrupted (marker-less) stage directory as complete', () => {
    const root = makeRoot();
    const dest = componentVersionDir(root, 'semble', COMPONENTS.semble.version);
    fs.mkdirSync(join(dest, 'bin'), { recursive: true });
    fs.writeFileSync(join(dest, 'bin', 'semble'), 'partial-corrupt');
    assert.equal(isStageComplete(dest, { fs, platform: 'linux' }), false);
  });

  it('reclaims an interrupted stage on retry instead of failing permanently', () => {
    const root = makeRoot();
    const dest = componentVersionDir(root, 'semble', COMPONENTS.semble.version);
    fs.mkdirSync(join(dest, 'bin'), { recursive: true });
    fs.writeFileSync(join(dest, 'bin', 'semble'), 'partial-corrupt');
    const result = stageSemble(root);
    assert.equal(result.destination, dest);
    assert.equal(isStageComplete(dest, { fs, platform: 'linux' }), true);
  });

  it('still refuses to overwrite a completed immutable stage', () => {
    const root = makeRoot();
    stageSemble(root);
    assert.throws(() => stageSemble(root), /immutable stage destination already exists/iu);
  });

  it('orchestrator isComponentStaged honours the completion marker, not bare directory existence', async () => {
    const home = makeRoot();
    const deps = createUpdateDependencies({ home, platform: 'linux' });
    const paths = updatePaths(home);
    const component = { name: 'semble', component: { version: COMPONENTS.semble.version } };
    const dest = componentVersionDir(paths.componentsRoot, 'semble', COMPONENTS.semble.version);
    fs.mkdirSync(dest, { recursive: true });
    assert.equal(await deps.isComponentStaged(component), false);
    stageComponent({
      name: 'semble',
      component: COMPONENTS.semble,
      root: paths.componentsRoot,
      platform: 'linux',
      fs,
      exec: () => materializeSembleVenv(dest),
    });
    assert.equal(await deps.isComponentStaged(component), true);
  });
});

import { createPlatformServiceTransactionAdapter } from '../src/update/update-orchestrator.mjs';

describe('Task 10 finding 6: macOS watchdog script participates in snapshot/rollback', { concurrency: false }, () => {
  it('captures and restores ~/.myelin/bin/watchdog.sh alongside its launch agent', async () => {
    const home = makeRoot();
    const plistPath = join(home, 'Library', 'LaunchAgents', 'com.myelin.watchdog.plist');
    const scriptPath = join(home, '.myelin', 'bin', 'watchdog.sh');
    fs.mkdirSync(join(home, 'Library', 'LaunchAgents'), { recursive: true });
    fs.mkdirSync(join(home, '.myelin', 'bin'), { recursive: true });
    fs.writeFileSync(plistPath, 'ORIGINAL PLIST');
    fs.writeFileSync(scriptPath, 'ORIGINAL WATCHDOG SCRIPT');

    const adapter = createPlatformServiceTransactionAdapter({
      home,
      platform: 'darwin',
      exec: () => { throw new Error('inactive'); },
    });

    const snapshot = await adapter.captureSupervisors();
    fs.writeFileSync(plistPath, 'MUTATED PLIST');
    fs.writeFileSync(scriptPath, 'MUTATED WATCHDOG SCRIPT');

    await adapter.restoreSupervisors(snapshot);

    assert.equal(fs.readFileSync(scriptPath, 'utf8'), 'ORIGINAL WATCHDOG SCRIPT');
    assert.equal(fs.readFileSync(plistPath, 'utf8'), 'ORIGINAL PLIST');
  });

  it('removes a watchdog script the update newly created when rolling back', async () => {
    const home = makeRoot();
    const plistPath = join(home, 'Library', 'LaunchAgents', 'com.myelin.watchdog.plist');
    const scriptPath = join(home, '.myelin', 'bin', 'watchdog.sh');
    fs.mkdirSync(join(home, 'Library', 'LaunchAgents'), { recursive: true });
    fs.writeFileSync(plistPath, 'ORIGINAL PLIST');

    const adapter = createPlatformServiceTransactionAdapter({
      home,
      platform: 'darwin',
      exec: () => { throw new Error('inactive'); },
    });
    const snapshot = await adapter.captureSupervisors();

    fs.mkdirSync(join(home, '.myelin', 'bin'), { recursive: true });
    fs.writeFileSync(scriptPath, 'NEW WATCHDOG SCRIPT');

    await adapter.restoreSupervisors(snapshot);
    assert.equal(fs.existsSync(scriptPath), false);
  });
});

import { stageRelease } from '../src/update/release-store.mjs';

function writeReleaseSource(root, version = '1.1.0') {
  fs.mkdirSync(join(root, 'bin'), { recursive: true });
  fs.mkdirSync(join(root, 'src', 'update'), { recursive: true });
  fs.mkdirSync(join(root, 'test'), { recursive: true });
  fs.writeFileSync(join(root, 'package.json'), JSON.stringify({
    name: 'myelin',
    version,
    bin: { myelin: './bin/myelin' },
  }));
  fs.writeFileSync(join(root, 'package-lock.json'), JSON.stringify({
    name: 'myelin',
    version,
    lockfileVersion: 3,
  }));
  fs.writeFileSync(join(root, 'bin', 'myelin'), '#!/usr/bin/env node\n');
  fs.writeFileSync(join(root, 'src', 'update', 'component-manifest.mjs'), 'export {};\n');
  fs.writeFileSync(join(root, 'test', 'component-manifest.test.mjs'), 'export {};\n');
}

function stageReleaseArgs(root, { exec } = {}) {
  const releasesRoot = join(root, '.myelin', 'releases');
  const source = join(root, 'source');
  writeReleaseSource(source);
  return {
    releasesRoot,
    args: {
      target: { channel: 'stable', version: '1.1.0', source: { type: 'directory', path: source } },
      releasesRoot,
      platform: 'linux',
      exec: exec ?? (() => ''),
    },
  };
}

describe('Task 10 finding 7: release stage is retryable after a rollback', { concurrency: false }, () => {
  it('reuses an already-staged valid release instead of failing on retry', async () => {
    const root = makeRoot();
    const { releasesRoot, args } = stageReleaseArgs(root);
    const first = await stageRelease(args);
    assert.equal(first.directory, join(releasesRoot, '1.1.0'));

    const commands = [];
    const second = await stageRelease({ ...args, exec: (file, a) => { commands.push([file, a]); return ''; } });
    assert.equal(second.version, '1.1.0');
    assert.equal(second.directory, join(releasesRoot, '1.1.0'));
    assert.deepEqual(commands, [], 'a valid staged release must be reused, not rebuilt');
  });

  it('clears a corrupt destination and restages instead of failing permanently', async () => {
    const root = makeRoot();
    const { releasesRoot, args } = stageReleaseArgs(root);
    fs.mkdirSync(join(releasesRoot, '1.1.0'), { recursive: true });
    fs.writeFileSync(join(releasesRoot, '1.1.0', 'garbage.txt'), 'corrupt partial');

    const commands = [];
    const result = await stageRelease({ ...args, exec: (file, a) => { commands.push([file, a]); return ''; } });
    assert.equal(result.directory, join(releasesRoot, '1.1.0'));
    assert.equal(fs.existsSync(join(releasesRoot, '1.1.0', 'package.json')), true);
    assert.equal(fs.existsSync(join(releasesRoot, '1.1.0', 'garbage.txt')), false);
    assert.deepEqual(commands, [
      ['npm', ['ci', '--ignore-scripts=false']],
      ['node', ['bin/myelin', '--version']],
      ['node', ['--test', 'test/component-manifest.test.mjs']],
    ]);
  });

  it('clears leftover staging debris from an interrupted attempt', async () => {
    const root = makeRoot();
    const { releasesRoot, args } = stageReleaseArgs(root);
    fs.mkdirSync(join(releasesRoot, '.1.1.0.staging'), { recursive: true });
    fs.writeFileSync(join(releasesRoot, '.1.1.0.staging', 'junk'), 'debris');

    const result = await stageRelease(args);
    assert.equal(result.version, '1.1.0');
    assert.equal(result.directory, join(releasesRoot, '1.1.0'));
  });
});

import { readFileSync as readFileSyncF8 } from 'node:fs';
import { fileURLToPath as fileURLToPathF8 } from 'node:url';
import {
  evaluateHeartbeatFailure,
  classifyHeartbeatFailure,
} from '../src/update/heartbeat-failure-budget.mjs';

// A flaky fs that forwards to real node:fs but can inject transient write
// failures on openSync (the exclusive heartbeat write path). Deriving from the
// module namespace keeps every other syscall real while shadowing openSync.
function makeFlakyFs(base) {
  const ctrl = { failOpenSync: 0, code: 'EIO' };
  const flaky = Object.create(base);
  flaky.openSync = (...args) => {
    if (ctrl.failOpenSync > 0) {
      ctrl.failOpenSync -= 1;
      const error = new Error('injected transient write failure');
      error.code = ctrl.code;
      throw error;
    }
    return base.openSync(...args);
  };
  return { fs: flaky, ctrl };
}

function makeScheduler() {
  const state = { fn: null, cleared: false };
  return {
    state,
    scheduler: {
      setInterval: fn => { state.fn = fn; return { unref() {} }; },
      clearInterval: () => { state.cleared = true; },
    },
    tick() { state.fn?.(); },
  };
}

function acquireForHeartbeat(root, flakyFs) {
  const lockPath = join(root, 'update.lock');
  let now = 1;
  const lock = createUpdateLock({
    fs: flakyFs,
    now: () => now,
    pid: 3131,
    isPidAlive: () => true,
    randomToken: () => 'hb-owner-token',
    staleAfterMs: 100_000,
    durability: { fsyncFile: () => {}, fsyncDirectory: () => {} },
  });
  const token = lock.acquire(lockPath);
  return { lock, token, lockPath, advance: value => { now = value; } };
}

describe('Task 10 finding 8: heartbeat survives transient I/O but stops on ownership loss', { concurrency: false }, () => {
  it('classifies ownership loss vs transient I/O (shared budget helper)', () => {
    const fenced = new Error('fenced'); fenced.code = 'ERR_UPDATE_FENCED';
    const io = new Error('io'); io.code = 'EIO';
    assert.equal(classifyHeartbeatFailure(fenced), 'ownership-lost');
    assert.equal(classifyHeartbeatFailure(io), 'transient');

    // Ownership loss is always terminal, regardless of counter.
    assert.deepEqual(
      evaluateHeartbeatFailure({ classification: 'ownership-lost', consecutiveFailures: 0 }),
      { consecutiveFailures: 0, stop: true, reason: 'ownership-lost' },
    );
    // Transient below budget keeps going.
    assert.deepEqual(
      evaluateHeartbeatFailure({ classification: 'transient', consecutiveFailures: 0, maxConsecutiveFailures: 3 }),
      { consecutiveFailures: 1, stop: false, reason: 'transient' },
    );
    // Transient at budget is terminal.
    assert.deepEqual(
      evaluateHeartbeatFailure({ classification: 'transient', consecutiveFailures: 2, maxConsecutiveFailures: 3 }),
      { consecutiveFailures: 3, stop: true, reason: 'transient-exhausted' },
    );
  });

  it('retries transient heartbeat write failures and recovers without surrendering the lock', () => {
    const root = makeRoot();
    const { fs: flaky, ctrl } = makeFlakyFs(fs);
    const { lock, token, lockPath, advance } = acquireForHeartbeat(root, flaky);
    const clock = makeScheduler();
    const terminal = [];

    const stop = lock.startHeartbeat(token, lockPath, 1000, {
      scheduler: clock.scheduler,
      maxConsecutiveFailures: 3,
      onTerminalFailure: info => terminal.push(info),
    });

    // Two consecutive transient write failures, then a success.
    ctrl.failOpenSync = 2;
    advance(10);
    clock.tick();
    advance(20);
    clock.tick();
    advance(30);
    clock.tick(); // succeeds, resets counter

    assert.equal(terminal.length, 0, 'transient failures must not be terminal');
    assert.equal(clock.state.cleared, false, 'the heartbeat loop must stay scheduled');
    assert.equal(fs.existsSync(`${lockPath}.heartbeat-hb-owner-token`), true);

    // Counter reset: two more transient failures still under budget.
    ctrl.failOpenSync = 2;
    advance(40);
    clock.tick();
    advance(50);
    clock.tick();
    assert.equal(terminal.length, 0, 'the failure counter must reset after a success');
    assert.equal(clock.state.cleared, false);

    stop();
  });

  it('stops terminally once transient failures exhaust the budget', () => {
    const root = makeRoot();
    const { fs: flaky, ctrl } = makeFlakyFs(fs);
    const { lock, token, lockPath, advance } = acquireForHeartbeat(root, flaky);
    const clock = makeScheduler();
    const terminal = [];

    lock.startHeartbeat(token, lockPath, 1000, {
      scheduler: clock.scheduler,
      maxConsecutiveFailures: 3,
      onTerminalFailure: info => terminal.push(info),
    });

    ctrl.failOpenSync = 3;
    advance(10);
    clock.tick();
    advance(20);
    clock.tick();
    assert.equal(terminal.length, 0, 'must not stop before the budget is exhausted');
    advance(30);
    clock.tick();

    assert.equal(clock.state.cleared, true, 'the loop must be cleared after exhausting the budget');
    assert.equal(terminal.length, 1);
    assert.equal(terminal[0].reason, 'transient-exhausted');
  });

  it('stops immediately on verified ownership loss (fenced) without waiting for the budget', () => {
    const root = makeRoot();
    const { fs: flaky } = makeFlakyFs(fs);
    const { lock, token, lockPath } = acquireForHeartbeat(root, flaky);
    const clock = makeScheduler();
    const terminal = [];

    lock.startHeartbeat(token, lockPath, 1000, {
      scheduler: clock.scheduler,
      maxConsecutiveFailures: 3,
      onTerminalFailure: info => terminal.push(info),
    });

    // Ownership is revoked: the lock file vanishes.
    fs.unlinkSync(lockPath);
    clock.tick();

    assert.equal(clock.state.cleared, true, 'ownership loss must stop the loop immediately');
    assert.equal(terminal.length, 1);
    assert.equal(terminal[0].reason, 'ownership-lost');
  });

  it('worker heartbeat retries transient I/O and reports terminal loss to the parent', () => {
    const workerSource = readFileSyncF8(
      fileURLToPathF8(new URL('../src/update/update-lock-heartbeat.mjs', import.meta.url)),
      'utf8',
    );
    // The worker must share the budget helper rather than stopping on any error.
    assert.match(workerSource, /evaluateHeartbeatFailure/);
    // It must notify the parent thread when it terminates.
    assert.match(workerSource, /heartbeat-terminated/);
    assert.match(workerSource, /postMessage/);
    // The blanket "any error -> stop()" catch must be gone.
    assert.doesNotMatch(workerSource, /\}\s*catch\s*\{\s*stop\(\);\s*\}/);
  });
});

describe('Task 10 finding 9: no-service (mcp/minimal) topology is preserved across updates', { concurrency: false }, () => {
  function serviceSnapshot({ present }) {
    const fileState = exists => ({
      exists,
      bytes: exists ? Buffer.from('definition') : undefined,
      mode: 0o600,
      metadata: {},
    });
    return {
      services: {
        definitions: {
          primary: { files: { '/svc/com.myelin.headroom.plist': fileState(present) } },
        },
        status: {},
      },
      supervisors: {
        definitions: {
          watchdog: { files: { '/svc/com.myelin.watchdog.plist': fileState(present) } },
        },
        status: {},
      },
    };
  }

  it('derives mcp when the pre-update snapshot has no managed service definitions, even if config resolves proxy', () => {
    assert.equal(
      deriveInstallProfile({ proxy: { engine: 'headroom_lite' } }, serviceSnapshot({ present: false })),
      'mcp',
      'a default config resolves proxy, but an install with no service files must stay no-service',
    );
  });

  it('derives proxy when the pre-update snapshot shows managed service definitions', () => {
    assert.equal(
      deriveInstallProfile({ proxy: { engine: 'headroom_lite' } }, serviceSnapshot({ present: true })),
      'proxy',
    );
  });

  it('runStagedApply preserves a no-service topology captured from the pre-update snapshot', async () => {
    const record = [];
    const deps = createUpdateDependencies({
      home: makeRoot(),
      platform: 'linux',
      stagedApplySpawn: fakeSpawn(record),
    });

    await deps.runStagedApply({
      plan: { config: { proxy: { engine: 'headroom_lite' } } }, // resolves proxy
      stagedRelease: { version: '1.1.0', directory: '/managed/releases/1.1.0' },
      lockToken: { token: 'transaction-token' },
      snapshot: serviceSnapshot({ present: false }),
    });

    const { args, options } = record[0];
    const profileIndex = args.indexOf('--profile');
    assert.equal(args[profileIndex + 1], 'mcp', 'a normal mcp/minimal install must not update into proxy services');
    assert.equal(options.env.MYELIN_UPDATE_PROFILE, 'mcp');
  });

  it('runStagedApply keeps proxy topology when the snapshot shows managed services', async () => {
    const record = [];
    const deps = createUpdateDependencies({
      home: makeRoot(),
      platform: 'linux',
      stagedApplySpawn: fakeSpawn(record),
    });

    await deps.runStagedApply({
      plan: { config: { proxy: { engine: 'headroom_lite' } } },
      stagedRelease: { version: '1.1.0', directory: '/managed/releases/1.1.0' },
      lockToken: { token: 'transaction-token' },
      snapshot: serviceSnapshot({ present: true }),
    });

    const { args } = record[0];
    assert.equal(args[args.indexOf('--profile') + 1], 'proxy');
  });
});

import {
  resolveManagedCompressionBinary,
  managedCompressionComponentName,
} from '../src/update/managed-service-binary.mjs';
import { activateComponent } from '../src/update/version-store.mjs';

describe('Task 10 finding 10: staged apply uses validated managed component pointers', { concurrency: false }, () => {
  function pinComponent({ componentsRoot, name, version, createBin }) {
    const versionDir = componentVersionDir(componentsRoot, name, version);
    fs.mkdirSync(versionDir, { recursive: true });
    if (createBin) {
      const binDir = join(versionDir, 'node_modules', '.bin');
      fs.mkdirSync(binDir, { recursive: true });
      fs.writeFileSync(join(binDir, 'headroom-lite'), '#!/bin/sh\necho staged\n');
    }
    activateComponent({ root: componentsRoot, name, version, platform: 'linux', fs });
    return versionDir;
  }

  it('maps compression backends to managed component names', () => {
    assert.equal(managedCompressionComponentName('headroom-lite'), 'headroomLite');
    assert.equal(managedCompressionComponentName('headroom-original'), 'headroomOriginal');
    assert.equal(managedCompressionComponentName('disabled'), null);
    assert.equal(managedCompressionComponentName(undefined), null);
  });

  it('resolves the pinned headroom-lite executable from the component pointer', () => {
    const componentsRoot = join(makeRoot(), 'components');
    const versionDir = pinComponent({
      componentsRoot,
      name: 'headroomLite',
      version: '0.31.0',
      createBin: true,
    });

    const resolved = resolveManagedCompressionBinary({
      backend: 'headroom-lite',
      componentsRoot,
      platform: 'linux',
      fs,
    });

    assert.equal(resolved.name, 'headroomLite');
    assert.equal(resolved.version, '0.31.0');
    assert.equal(resolved.binPath, join(versionDir, 'node_modules', '.bin', 'headroom-lite'));
  });

  it('throws when the pinned executable is missing rather than falling back to global tools', () => {
    const componentsRoot = join(makeRoot(), 'components');
    pinComponent({
      componentsRoot,
      name: 'headroomLite',
      version: '0.31.0',
      createBin: false,
    });

    assert.throws(
      () => resolveManagedCompressionBinary({
        backend: 'headroom-lite',
        componentsRoot,
        platform: 'linux',
        fs,
      }),
      error => error?.code === 'ERR_UPDATE_PINNED_EXECUTABLE_MISSING',
    );
  });

  it('throws when no component pointer has been pinned yet', () => {
    const componentsRoot = join(makeRoot(), 'components');
    fs.mkdirSync(componentsRoot, { recursive: true });

    assert.throws(
      () => resolveManagedCompressionBinary({
        backend: 'headroom-lite',
        componentsRoot,
        platform: 'linux',
        fs,
      }),
      error => error?.code === 'ERR_UPDATE_PINNED_EXECUTABLE_MISSING',
    );
  });

  it('install.mjs overrides compression service binaries with managed pointers under update-apply', () => {
    const source = readFileSync(
      fileURLToPath(new URL('../src/install.mjs', import.meta.url)),
      'utf8',
    );
    assert.match(
      source,
      /resolveManagedCompressionBinary/,
      'install.mjs must resolve managed compression binaries under update-apply',
    );
  });
});

describe('Task 10 finding 11: legacy migration is suppressed during a staged apply', { concurrency: false }, () => {
  const installSource = readFileSync(
    fileURLToPath(new URL('../src/install.mjs', import.meta.url)),
    'utf8',
  );

  it('gates the ~/.tokenstack legacy migration block behind !flags[update-apply]', () => {
    assert.match(
      installSource,
      /!flags\['dry-run'\]\s*&&\s*!flags\['update-apply'\]\)\s*\{[\s\S]{0,60}Migrate ~\/\.tokenstack/,
      'the destructive legacy migration must not run under a transactional update-apply',
    );
  });
});

describe('Task 10 finding 12: staged apply does not mutate CA bundles', { concurrency: false }, () => {
  const installSource = readFileSync(
    fileURLToPath(new URL('../src/install.mjs', import.meta.url)),
    'utf8',
  );

  it('skips buildCombinedCaCert during a staged apply', () => {
    assert.match(
      installSource,
      /combinedCert\s*=\s*flags\['update-apply'\]\s*\?\s*null\s*:\s*await buildCombinedCaCert/,
      'a staged apply must not rebuild/mutate the combined CA bundle',
    );
  });

  it('gates the mitmproxy CA install behind an update-apply branch that reuses the existing bundle', () => {
    // Reconcile note (Option A): main's canonical install uses a single sslEnv
    // (buildCorporateSslEnv) rather than the retired feature's buildInstallSslEnvs
    // local/service split. The requirement — staged apply must not regenerate or
    // append to global CA bundles — is preserved via a dedicated update-apply
    // branch that reuses the managed release bundle before the normal CA path.
    assert.match(
      installSource,
      /else if \(flags\['update-apply'\]\)\s*\{[\s\S]{0,400}managed release[\s\S]{0,400}\}\s*else if \(mitmdumpBin\)\s*\{/,
      'under update-apply the CA install block must be replaced by a no-write reuse of the managed bundle',
    );
  });
});

import { createTransactionAbort } from '../src/update/update-orchestrator.mjs';

describe('Task 10 finding 13: terminal heartbeat failure aborts before further mutation', { concurrency: false }, () => {
  it('fence rejects with ERR_UPDATE_ABORTED once the transaction is aborted, until recovery begins', async () => {
    let held = 0;
    const abort = createTransactionAbort({ assertHeld: async () => { held += 1; } });

    await abort.fence({ token: 't' });
    assert.equal(held, 1, 'a live transaction still asserts the held lock');

    abort.trigger('ownership-lost');
    assert.equal(abort.aborted, true);
    await assert.rejects(
      () => abort.fence({ token: 't' }),
      error => error?.code === 'ERR_UPDATE_ABORTED',
    );
    assert.equal(held, 1, 'an aborted fence must not run any further mutation guard');

    abort.beginRecovery();
    await abort.fence({ token: 't' });
    assert.equal(held, 2, 'recovery lets the fenced rollback restore state');
  });

  it('runStagedApply refuses to spawn once the transaction is already aborted', async () => {
    const record = [];
    const deps = createUpdateDependencies({
      home: makeRoot(),
      platform: 'linux',
      stagedApplySpawn: fakeSpawn(record),
    });
    const controller = new AbortController();
    controller.abort();

    await assert.rejects(
      () => deps.runStagedApply({
        plan: { config: { proxy: { compression: { enabled: false } } } },
        stagedRelease: { version: '1.1.0', directory: '/managed/releases/1.1.0' },
        lockToken: { token: 'transaction-token' },
        abortSignal: controller.signal,
      }),
      error => error?.code === 'ERR_UPDATE_ABORTED',
    );
    assert.equal(record.length, 0, 'a terminated transaction must not launch a staged apply');
  });

  it('a terminal heartbeat during a long staged apply cancels before starting services and rolls back', async () => {
    const events = [];
    const abort = createTransactionAbort({ assertHeld: async () => {} });
    const deps = createUpdateDependencies({
      home: makeRoot(),
      platform: 'linux',
      ...stubbedTransactionOverrides(events),
    });
    // Simulate a long staged apply during which the heartbeat terminally fails
    // (ownership lost). The apply itself completes, but the transaction is now
    // aborted, so no further mutation must occur.
    deps.runStagedApply = async () => {
      events.push('staged-apply');
      abort.trigger('ownership-lost');
    };
    deps.fence = abort.fence;

    const plan = {
      channel: 'stable',
      backend: 'disabled',
      config: { proxy: { compression: { enabled: false }, mitm: { enabled: false } } },
      components: [],
      release: { current: '1.1.0', previous: '1.0.0' },
      desiredConfig: noServiceConfigSnapshot(),
      stagedRelease: { version: '1.1.0', directory: '/managed/releases/1.1.0' },
    };

    const context = { lockToken: { token: 'transaction-token' }, abort, abortSignal: abort.signal };
    const result = await activateUpdate(plan, deps, context);

    assert.equal(result.ok, false);
    assert.equal(result.status, 'rolled-back');
    assert.equal(result.error?.code, 'ERR_UPDATE_ABORTED');
    assert.ok(events.includes('staged-apply'), 'the staged apply ran');
    assert.ok(!events.includes('start-services'), 'no service must be started after a terminal abort');
    assert.ok(!events.includes('start-supervisors'), 'no supervisor must be started after a terminal abort');
    assert.ok(events.includes('restore-release'), 'the aborted transaction must roll back');
  });
});

import { resolveManagedMitmBinary } from '../src/update/managed-service-binary.mjs';

describe('Task 10 finding 14: staged apply resolves mitmproxy from a managed pointer', { concurrency: false }, () => {
  function pinMitm({ componentsRoot, version, createBin }) {
    const versionDir = componentVersionDir(componentsRoot, 'mitmproxy', version);
    fs.mkdirSync(versionDir, { recursive: true });
    if (createBin) {
      const binDir = join(versionDir, 'bin');
      fs.mkdirSync(binDir, { recursive: true });
      fs.writeFileSync(join(binDir, 'mitmdump'), '#!/bin/sh\necho staged-mitm\n');
    }
    activateComponent({ root: componentsRoot, name: 'mitmproxy', version, platform: 'linux', fs });
    return versionDir;
  }

  it('resolves the pinned mitmdump executable from components/mitmproxy/current', () => {
    const componentsRoot = join(makeRoot(), 'components');
    const versionDir = pinMitm({ componentsRoot, version: '12.2.3', createBin: true });

    const resolved = resolveManagedMitmBinary({
      componentsRoot,
      platform: 'linux',
      fs,
    });

    assert.equal(resolved.name, 'mitmproxy');
    assert.equal(resolved.version, '12.2.3');
    assert.equal(resolved.binPath, join(versionDir, 'bin', 'mitmdump'));
  });

  it('throws instead of falling back to a global mitmdump when the pinned binary is missing', () => {
    const componentsRoot = join(makeRoot(), 'components');
    pinMitm({ componentsRoot, version: '12.2.3', createBin: false });

    assert.throws(
      () => resolveManagedMitmBinary({ componentsRoot, platform: 'linux', fs }),
      error => error?.code === 'ERR_UPDATE_PINNED_EXECUTABLE_MISSING',
    );
  });

  it('throws when no mitmproxy pointer has been pinned', () => {
    const componentsRoot = join(makeRoot(), 'components');
    fs.mkdirSync(componentsRoot, { recursive: true });

    assert.throws(
      () => resolveManagedMitmBinary({ componentsRoot, platform: 'linux', fs }),
      error => error?.code === 'ERR_UPDATE_PINNED_EXECUTABLE_MISSING',
    );
  });

  it('install.mjs resolves the managed mitm binary under update-apply with no global fallback', () => {
    const source = readFileSync(
      fileURLToPath(new URL('../src/install.mjs', import.meta.url)),
      'utf8',
    );
    assert.match(
      source,
      /resolveManagedMitmBinary/,
      'install.mjs must resolve mitmdump from the managed pointer under update-apply',
    );
    // The global mitmproxy detection must not run under update-apply.
    assert.match(
      source,
      /\}\s*else\s*\{\s*mitmdumpBin \?\?= await ensureMitmproxy/,
      'ensureMitmproxy global detection must be confined to the non-update-apply branch',
    );
  });
});

describe('Task 10 finding 15: staged apply does not delete legacy service definitions', { concurrency: false }, () => {
  const installSource = readFileSync(
    fileURLToPath(new URL('../src/install.mjs', import.meta.url)),
    'utf8',
  );

  it('skips destructive legacy compression service cleanup under update-apply', () => {
    // The transaction journal only snapshots Myelin-owned current service
    // definitions, so deleting legacy definitions before commit cannot be rolled
    // back. Under update-apply the cleanup must be skipped, not executed.
    //
    // Reconcile note (Option A): main's canonical architecture performs obsolete
    // instance cleanup inside applyServiceEngineInstallPlan
    // (removeObsoleteOwnedInstances et al.), not via the retired feature helper
    // removeLegacyCompressionServices. The requirement is preserved by threading
    // skipObsoleteCleanup: flags['update-apply'] into the service install plan,
    // which gates every owned-instance removal off during a staged apply.
    assert.match(
      installSource,
      /skipObsoleteCleanup:\s*flags\['update-apply'\]/,
      'legacy service cleanup must be gated off during a transactional staged apply',
    );
  });
});

describe('Task 10 finding 16: abort waits for staged-child quiescence before rollback', { concurrency: false }, () => {
  const syncScheduler = {
    setTimeout: cb => { cb(); return { unref() {} }; },
    clearTimeout: () => {},
  };

  function abortableChild({ exitOnTerm }) {
    const child = new EventEmitter();
    child.killed = [];
    child.kill = signal => {
      child.killed.push(signal);
      if (exitOnTerm && signal === 'SIGTERM') child.emit('exit', null, 'SIGTERM');
    };
    return child;
  }

  it('rejects ERR_UPDATE_ABORTED only after the staged child confirms termination', async () => {
    const child = abortableChild({ exitOnTerm: true });
    const controller = new AbortController();
    const deps = createUpdateDependencies({
      home: makeRoot(),
      platform: 'linux',
      stagedApplySpawn: () => child,
      stagedAbortScheduler: syncScheduler,
    });

    const pending = deps.runStagedApply({
      plan: { config: { proxy: { compression: { enabled: false } } } },
      stagedRelease: { version: '1.1.0', directory: '/managed/releases/1.1.0' },
      lockToken: { token: 'transaction-token' },
      abortSignal: controller.signal,
    });
    controller.abort();

    await assert.rejects(() => pending, error => error?.code === 'ERR_UPDATE_ABORTED');
    assert.deepEqual(child.killed, ['SIGTERM'], 'a cooperative child needs no SIGKILL escalation');
  });

  it('escalates SIGTERM then SIGKILL and fails closed when the child will not quiesce', async () => {
    const child = abortableChild({ exitOnTerm: false });
    const controller = new AbortController();
    const deps = createUpdateDependencies({
      home: makeRoot(),
      platform: 'linux',
      stagedApplySpawn: () => child,
      stagedAbortScheduler: syncScheduler,
    });

    const pending = deps.runStagedApply({
      plan: { config: { proxy: { compression: { enabled: false } } } },
      stagedRelease: { version: '1.1.0', directory: '/managed/releases/1.1.0' },
      lockToken: { token: 'transaction-token' },
      abortSignal: controller.signal,
    });
    controller.abort();

    await assert.rejects(
      () => pending,
      error => error?.code === 'ERR_UPDATE_ABORT_UNQUIESCED',
    );
    assert.deepEqual(child.killed, ['SIGTERM', 'SIGKILL'], 'bounded escalation must reach SIGKILL');
  });

  it('an unquiesced abort fails closed: journal retained, no rollback restoration', async () => {
    const events = [];
    const abort = createTransactionAbort({ assertHeld: async () => {} });
    const deps = createUpdateDependencies({
      home: makeRoot(),
      platform: 'linux',
      ...stubbedTransactionOverrides(events),
    });
    deps.retainJournal = async () => events.push('retain-journal');
    deps.runStagedApply = async () => {
      events.push('staged-apply');
      abort.trigger('ownership-lost');
      const error = new Error('staged child did not quiesce');
      error.code = 'ERR_UPDATE_ABORT_UNQUIESCED';
      throw error;
    };
    deps.fence = abort.fence;

    const plan = {
      channel: 'stable',
      backend: 'disabled',
      config: { proxy: { compression: { enabled: false }, mitm: { enabled: false } } },
      components: [],
      release: { current: '1.1.0', previous: '1.0.0' },
      desiredConfig: noServiceConfigSnapshot(),
      stagedRelease: { version: '1.1.0', directory: '/managed/releases/1.1.0' },
    };

    const context = { lockToken: { token: 'transaction-token' }, abort, abortSignal: abort.signal };
    const result = await activateUpdate(plan, deps, context);

    assert.equal(result.ok, false);
    assert.equal(result.status, 'aborted-unquiesced-journal-retained');
    assert.equal(result.error?.code, 'ERR_UPDATE_ABORT_UNQUIESCED');
    assert.ok(events.includes('staged-apply'));
    assert.ok(events.includes('retain-journal'), 'the journal must be retained for a later fenced recovery');
    assert.ok(!events.includes('restore-release'), 'must not race restoration against a live staged child');
    assert.ok(!events.includes('cleanup-journal'), 'a fail-closed abort must not clean up the journal');
  });
});

describe('PR #23 finding 6: post-spawn journal-write failure must not race rollback against a live child', { concurrency: false }, () => {
  const syncScheduler = {
    setTimeout: cb => { cb(); return { unref() {} }; },
    clearTimeout: () => {},
  };

  function abortableChild({ exitOnTerm }) {
    const child = new EventEmitter();
    child.killed = [];
    child.kill = signal => {
      child.killed.push(signal);
      if (exitOnTerm && signal === 'SIGTERM') child.emit('exit', null, 'SIGTERM');
    };
    return child;
  }

  it('quiesces a cooperative child before rejecting when onChildSpawn (journal write) throws', async () => {
    // The child exits cleanly once SIGTERM'd, so once quiesced it is safe to
    // reject with the original journal-write error and let rollback proceed.
    const child = abortableChild({ exitOnTerm: true });
    const deps = createUpdateDependencies({
      home: makeRoot(),
      platform: 'linux',
      stagedApplySpawn: () => child,
      stagedAbortScheduler: syncScheduler,
    });

    const pending = deps.runStagedApply({
      plan: { config: { proxy: { compression: { enabled: false } } } },
      stagedRelease: { version: '1.1.0', directory: '/managed/releases/1.1.0' },
      lockToken: { token: 'transaction-token' },
      onChildSpawn: async () => {
        throw new Error('failed to persist child pid to the journal');
      },
    });

    await assert.rejects(() => pending);
    assert.deepEqual(
      child.killed,
      ['SIGTERM'],
      'a post-spawn journal-write failure must terminate the child before the handler settles',
    );
  });

  it('fails closed with ERR_UPDATE_ABORT_UNQUIESCED carrying the child pid when the child will not quiesce', async () => {
    const child = abortableChild({ exitOnTerm: false });
    child.pid = 4242;
    const deps = createUpdateDependencies({
      home: makeRoot(),
      platform: 'linux',
      stagedApplySpawn: () => child,
      stagedAbortScheduler: syncScheduler,
    });

    const pending = deps.runStagedApply({
      plan: { config: { proxy: { compression: { enabled: false } } } },
      stagedRelease: { version: '1.1.0', directory: '/managed/releases/1.1.0' },
      lockToken: { token: 'transaction-token' },
      onChildSpawn: async () => {
        throw new Error('failed to persist child pid to the journal');
      },
    });

    await assert.rejects(
      () => pending,
      error => error?.code === 'ERR_UPDATE_ABORT_UNQUIESCED'
        && error?.unquiescedChild?.pid === 4242,
    );
    assert.deepEqual(
      child.killed,
      ['SIGTERM', 'SIGKILL'],
      'an unresponsive child must still be escalated to SIGKILL before failing closed',
    );
  });

});

import { recoverUpdateJournal, createUpdateJournalStore } from '../src/update/update-orchestrator.mjs';

describe('Task 10 finding 17: recovery refuses to restore while the staged child may be live', { concurrency: false }, () => {
  function transactionStubsWithRealJournal(events) {
    // Reuse the shared mutation stubs but keep the *real* durable journal store
    // (read/write/cleanup) so the round trip persists across recovery attempts.
    const overrides = stubbedTransactionOverrides(events);
    delete overrides.writeJournal;
    delete overrides.cleanupJournal;
    return overrides;
  }

  const plan = {
    channel: 'stable',
    backend: 'disabled',
    config: { proxy: { compression: { enabled: false }, mitm: { enabled: false } } },
    components: [],
    release: { current: '1.1.0', previous: '1.0.0' },
    desiredConfig: noServiceConfigSnapshot(),
    stagedRelease: { version: '1.1.0', directory: '/managed/releases/1.1.0' },
  };

  async function driveUnquiescedAbort(deps, stagedChildPid) {
    const abort = createTransactionAbort({ assertHeld: async () => {} });
    deps.fence = abort.fence;
    deps.runStagedApply = async () => {
      abort.trigger('ownership-lost');
      const error = new Error('staged child did not quiesce');
      error.code = 'ERR_UPDATE_ABORT_UNQUIESCED';
      error.unquiescedChild = { pid: stagedChildPid };
      throw error;
    };
    const context = { lockToken: { token: 'transaction-token' }, abort, abortSignal: abort.signal };
    return activateUpdate(plan, deps, context);
  }

  function recoveryContext(token) {
    const abort = createTransactionAbort({ assertHeld: async () => {} });
    return { abort, context: { lockToken: { token }, abort, abortSignal: abort.signal } };
  }

  it('persists a durable unresolved-child marker and refuses rollback until the child is confirmed gone', async () => {
    const events = [];
    const home = makeRoot();
    let childAlive = true;
    const deps = createUpdateDependencies({
      home,
      platform: 'linux',
      journal: createUpdateJournalStore({ path: updatePaths(home).journalPath, fs, durability: { fsyncFile: () => {}, fsyncDirectory: () => {} } }),
      ...transactionStubsWithRealJournal(events),
    });
    deps.isStagedChildAlive = async () => childAlive;

    // 1) An unquiesced abort must leave a durable prepared journal carrying the
    //    staged child's pid so a *separate* recovery can fence against it.
    const activation = await driveUnquiescedAbort(deps, 987654);
    assert.equal(activation.status, 'aborted-unquiesced-journal-retained');

    const persisted = await deps.readJournal();
    assert.ok(persisted, 'the journal must survive the unquiesced abort');
    assert.equal(persisted.phase, 'prepared');
    assert.equal(persisted.unresolvedChild?.pid, 987654, 'the child pid must be durably recorded');
    assert.notEqual(persisted.unresolvedChild?.resolved, true, 'the child liveness must start unresolved');

    // 2) A separate recovery attempt while the child may still be alive MUST NOT
    //    restore anything; it fails closed and retains the journal.
    events.length = 0;
    const first = recoveryContext('recovery-token-1');
    deps.fence = first.abort.fence;
    await assert.rejects(
      () => recoverUpdateJournal(deps, first.context),
      error => error?.code === 'ERR_UPDATE_RECOVERY_CHILD_ALIVE',
    );
    assert.ok(!events.includes('restore-release'), 'recovery must not restore while the child may live');
    assert.ok(!events.includes('restore-services'), 'recovery must not restore service definitions while the child may live');
    const stillRetained = await deps.readJournal();
    assert.ok(stillRetained, 'a deferred recovery must retain the journal');
    assert.notEqual(stillRetained.unresolvedChild?.resolved, true, 'liveness stays unresolved while the child may live');

    // 3) Once the child is confirmed gone, recovery may finally roll back and
    //    clear the journal.
    events.length = 0;
    childAlive = false;
    const second = recoveryContext('recovery-token-2');
    deps.fence = second.abort.fence;
    const recovered = await recoverUpdateJournal(deps, second.context);
    assert.equal(recovered.ok, true);
    assert.equal(recovered.status, 'recovered-prepared');
    assert.ok(events.includes('restore-release'), 'a resolved child lets the journaled rollback run');
    assert.equal(await deps.readJournal(), null, 'a completed recovery cleans up the journal');
  });

  it('treats an unknown recorded pid as still-live and fails closed', async () => {
    const events = [];
    const home = makeRoot();
    const deps = createUpdateDependencies({
      home,
      platform: 'linux',
      journal: createUpdateJournalStore({ path: updatePaths(home).journalPath, fs, durability: { fsyncFile: () => {}, fsyncDirectory: () => {} } }),
      ...transactionStubsWithRealJournal(events),
    });
    // No isStagedChildAlive override: the default resolver must treat a missing
    // pid conservatively (possibly alive) and refuse to restore.

    const activation = await driveUnquiescedAbort(deps, null);
    assert.equal(activation.status, 'aborted-unquiesced-journal-retained');
    const persisted = await deps.readJournal();
    assert.equal(persisted.unresolvedChild?.pid, null);

    events.length = 0;
    const attempt = recoveryContext('recovery-token');
    deps.fence = attempt.abort.fence;
    await assert.rejects(
      () => recoverUpdateJournal(deps, attempt.context),
      error => error?.code === 'ERR_UPDATE_RECOVERY_CHILD_ALIVE',
    );
    assert.ok(!events.includes('restore-release'), 'an unknown pid must not be assumed dead');
    assert.ok(await deps.readJournal(), 'the journal is retained when liveness is unknown');
  });
});
