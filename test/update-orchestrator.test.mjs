import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { join } from 'node:path';

import {
  createUpdateLock,
  createUpdateJournalStore,
  createPlatformServiceTransactionAdapter,
  planUpdate,
  runUpdate,
  activateUpdate,
  rollbackUpdate,
  recoverUpdateJournal,
} from '../src/update/update-orchestrator.mjs';
import { resolveCompressionConfig } from '../src/update/engine-selection.mjs';
import { load as loadYaml } from 'js-yaml';

const temporaryRoots = [];

function makeRoot() {
  const root = fs.mkdtempSync(join(process.cwd(), '.test-update-orchestrator-'));
  temporaryRoots.push(root);
  return root;
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function rawConfig(content = 'proxy:\n  engine: headroom_lite\n') {
  return {
    exists: true,
    bytes: Buffer.from(content),
    mode: 0o640,
    metadata: {
      uid: 501,
      gid: 20,
      acl: { entries: ['user:me:rw'] },
      attributes: { hidden: false },
    },
  };
}

function completeState({
  config = rawConfig(),
  release = { current: '1.0.0', previous: '0.9.0' },
  components = {
    headroomLite: { current: '0.30.0', previous: '0.29.0' },
  },
  services = { primary: { definition: 'old-primary', running: true } },
  supervisors = { watchdog: { definition: 'old-watchdog', running: true } },
} = {}) {
  return { config, release, components, services, supervisors };
}

function preparedJournal(overrides = {}) {
  const snapshot = completeState();
  return {
    schemaVersion: 1,
    transactionId: 'transaction-token',
    phase: 'prepared',
    cleanupState: 'pending',
    snapshot,
    desired: {
      ...completeState({
        config: rawConfig('proxy:\n  engine: headroom_lite\n'),
        release: { current: '1.1.0', previous: '1.0.0' },
        components: {
          headroomLite: { current: '0.31.0', previous: '0.30.0' },
        },
        services: { primary: { definition: 'new-primary', running: true } },
        supervisors: { watchdog: { definition: 'new-watchdog', running: true } },
      }),
    },
    ...overrides,
  };
}

function baseDeps(events = []) {
  return {
    stageRelease: async () => ({ version: '1.1.0', directory: '/managed/releases/1.1.0' }),
    readStagedManifest: async () => ({
      headroomLite: {
        kind: 'npm-git',
        package: 'github:yehsuf/headroom-lite',
        version: '0.31.0',
        ref: 'v0.31.0',
        bin: 'headroom-lite',
      },
      headroomOriginal: {
        kind: 'uv-venv',
        package: 'headroom-ai[proxy]',
        version: '0.31.0',
        bin: 'headroom',
      },
    }),
    stageComponent: async ({ name }) => events.push(`stage:${name}`),
    captureSnapshot: async () => completeState(),
    writeJournal: async journal => events.push(`journal:${journal.phase}`),
    quiesceServices: async () => events.push('quiesce-services'),
    quiesceSupervisors: async () => events.push('quiesce-supervisors'),
    applyComponentPairs: async () => events.push('apply-components'),
    writeConfig: async () => events.push('write-config'),
    applyReleasePair: async () => events.push('apply-release'),
    runStagedApply: async () => events.push('staged-apply'),
    startServices: async () => events.push('start-services'),
    startSupervisors: async () => events.push('start-supervisors'),
    verify: async () => true,
    cleanupJournal: async () => events.push('cleanup-journal'),
    cleanupStaging: async () => events.push('cleanup-staging'),
    stopNewServicesAndWatchdogs: async () => events.push('stop-new'),
    restoreComponentPairs: async () => events.push('restore-components'),
    restoreReleasePair: async () => events.push('restore-release'),
    restoreConfig: async () => events.push('restore-config'),
    restoreServiceDefinitions: async () => events.push('restore-services'),
    restoreSupervisors: async () => events.push('restore-supervisors'),
    restoreServiceStatus: async () => events.push('restore-service-status'),
    restoreSupervisorStatus: async () => events.push('restore-supervisor-status'),
    fence: () => events.push('fence'),
  };
}

describe('planUpdate', { concurrency: false }, () => {
  it('defaults to main and stages only the selected compression backend', () => {
    const plan = planUpdate({
      config: { proxy: { engine: 'headroom_lite' } },
      manifest: {
        headroomLite: { version: '0.31.0' },
        headroomOriginal: { version: '0.31.0' },
        serena: { version: '1.6.0' },
      },
      installed: {
        headroomLite: { current: '0.30.0', previous: null },
        serena: { current: '1.6.0', previous: null },
      },
      target: { version: '1.1.0' },
    });

    assert.equal(plan.channel, 'main');
    assert.deepEqual(plan.components.map(({ name }) => name), ['headroomLite', 'serena']);
    assert.deepEqual(plan.release, {
      current: '1.1.0',
      previous: null,
    });
  });

  it('selects original Headroom rather than headroom-lite', () => {
    const plan = planUpdate({
      channel: 'main',
      config: { proxy: { engine: 'headroom' } },
      manifest: {
        headroomLite: { version: '0.31.0' },
        headroomOriginal: { version: '0.31.0' },
      },
      target: { version: 'main-0123456789abcdef0123456789abcdef01234567' },
    });

    assert.equal(plan.channel, 'main');
    assert.deepEqual(plan.components.map(({ name }) => name), ['headroomOriginal']);
  });

  it('rejects non-stable and non-main channels before planning', () => {
    assert.throws(
      () => planUpdate({ channel: 'nightly', config: {}, manifest: {}, target: { version: '1.1.0' } }),
      /invalid update channel/i,
    );
  });

  it('keeps an explicit legacy Copilot toggle when planning raw-YAML config (bypasses loadConfig)', () => {
    // The orchestrator parses the config file with js-yaml directly and never
    // runs loadConfig's canonical<->legacy reconciliation. A raw config that
    // selects a canonical backend but enables the Copilot proxy via the LEGACY
    // key must still resolve to copilotProxy.enabled=true, or the update would
    // stop a Copilot proxy the user explicitly enabled.
    const parsed = loadYaml(
      'compression:\n  backend: headroom-lite\nproxy:\n  copilot_headroom:\n    enabled: true\n',
    );
    const plan = planUpdate({
      channel: 'stable',
      config: parsed,
      manifest: { headroomLite: { version: '0.31.0' } },
      target: { version: '1.1.0' },
    });
    // Mirrors the orchestrator's own consumption at activateUpdate:
    // resolveCompressionConfig(plan.config).
    assert.equal(resolveCompressionConfig(plan.config).copilotProxy.enabled, true);
  });
});

describe('read-only update checks', { concurrency: false }, () => {
  it('does not acquire a lock, write migration output, or mutate state', async () => {
    const events = [];
    const home = makeRoot();
    let detectCalls = 0;
    const result = await runUpdate(
      { channel: 'stable', check: true },
      {
        home,
        readRawConfig: async () => rawConfig('proxy:\n  headroom_lite:\n    enabled: true\n'),
        resolveTarget: async () => ({ version: '1.1.0' }),
        detectInstalled: async () => {
          detectCalls += 1;
          return { headroomLite: { current: null, previous: null } };
        },
        inspectLock: async () => ({ held: true, owner: { pid: 44, token: 'other' } }),
        readJournal: async () => ({ phase: 'prepared' }),
        report: value => events.push(value),
        acquireLock: () => { throw new Error('must not acquire'); },
        writeConfig: () => { throw new Error('must not write'); },
        stageRelease: () => { throw new Error('must not stage'); },
        stageComponent: () => { throw new Error('must not stage'); },
        manifest: {
          headroomLite: {
            kind: 'npm-git',
            package: 'github:yehsuf/headroom-lite',
            version: '0.31.0',
            ref: 'v0.31.0',
            bin: 'headroom-lite',
          },
        },
      },
    );

    assert.equal(result.ok, true);
    assert.equal(result.status, 'checked');
    assert.equal(result.lock.held, true);
    assert.equal(result.journal.phase, 'prepared');
    assert.equal(events.length, 1);
    assert.equal(detectCalls, 1);
  });
});

describe('fenced update execution', { concurrency: false }, () => {
  it('checks the global fence immediately before every transaction mutation', async () => {
    const events = [];
    const deps = baseDeps(events);
    const token = { token: 'transaction-token', pid: 101 };
    deps.paths = { lockPath: '/isolated/update.lock' };
    deps.lock = {
      acquire: () => token,
      assertHeld: candidate => {
        assert.equal(candidate, token);
        events.push('fence');
      },
      startHeartbeat: () => () => {},
      release: candidate => {
        assert.equal(candidate, token);
        events.push('release-lock');
      },
    };
    deps.readJournal = async () => null;
    deps.readRawConfig = async () => rawConfig();
    deps.resolveTarget = async () => ({
      channel: 'stable',
      repository: 'yehsuf/myelin',
      sourceValidated: true,
      version: '1.1.0',
      tag: 'v1.1.0',
      source: {
        type: 'tarball',
        url: 'https://api.github.com/repos/yehsuf/myelin/tarball/v1.1.0',
      },
    });
    deps.stageRelease = async () => {
      events.push('stage-release');
      return { version: '1.1.0', directory: '/managed/releases/1.1.0' };
    };
    deps.readStagedManifest = async () => ({
      headroomLite: {
        kind: 'npm-git',
        package: 'github:yehsuf/headroom-lite',
        version: '0.31.0',
        ref: 'v0.31.0',
        bin: 'headroom-lite',
      },
    });
    deps.detectInstalled = async () => ({});
    deps.isComponentStaged = async () => false; // always re-stage in this test

    const result = await runUpdate({ channel: 'stable' }, deps);

    assert.equal(result.ok, true);
    for (const mutation of [
      'stage-release',
      'stage:headroomLite',
      'journal:prepared',
      'quiesce-services',
      'quiesce-supervisors',
      'apply-components',
      'write-config',
      'apply-release',
      'staged-apply',
      'start-services',
      'start-supervisors',
      'journal:committed',
      'cleanup-journal',
    ]) {
      const index = events.indexOf(mutation);
      assert.ok(index > 0, `missing fenced mutation ${mutation}`);
      assert.equal(events[index - 1], 'fence', `${mutation} must immediately follow a fence`);
    }
    assert.equal(events.at(-1), 'release-lock');
  });
});

describe('durable global update lock', { concurrency: false }, () => {
  it('reclaims a stale heartbeat and fences the old owner', () => {
    const root = makeRoot();
    const path = join(root, 'update.lock');
    fs.writeFileSync(path, JSON.stringify({
      schemaVersion: 1,
      token: 'stale-owner',
      pid: 9,
      startedAt: 1,
      heartbeatAt: 1,
    }));
    const lock = createUpdateLock({
      fs,
      now: () => 10_000,
      isPidAlive: () => false,
      randomToken: () => 'new-owner',
      staleAfterMs: 100,
    });

    const token = lock.acquire(path);

    assert.equal(token.token, 'new-owner');
    assert.throws(() => lock.assertHeld({ token: 'stale-owner' }, path), /fenced|owner/i);
    assert.doesNotThrow(() => lock.assertHeld(token, path));
    lock.release(token, path);
    assert.equal(fs.existsSync(path), false);
  });

  it('rejects a live fresh owner with its advisory PID and start time', () => {
    const root = makeRoot();
    const path = join(root, 'update.lock');
    fs.writeFileSync(path, JSON.stringify({
      schemaVersion: 1,
      token: 'live-owner',
      pid: 4242,
      startedAt: 90,
      heartbeatAt: 99,
    }));
    const lock = createUpdateLock({
      fs,
      now: () => 100,
      isPidAlive: () => true,
      randomToken: () => 'new-owner',
      staleAfterMs: 1_000,
    });

    assert.throws(() => lock.acquire(path), /4242.*start|already held/i);
  });

  it('uses the token-scoped heartbeat without rewriting the owner lock', () => {
    const root = makeRoot();
    const path = join(root, 'update.lock');
    let now = 0;
    const owner = createUpdateLock({
      fs,
      now: () => now,
      pid: 101,
      isPidAlive: () => true,
      randomToken: () => 'owner-token',
      staleAfterMs: 100,
      useWorkerHeartbeat: false,
      durability: { fsyncFile: () => {} },
    });
    const token = owner.acquire(path);
    now = 90;
    owner.heartbeat(token, path);

    const contender = createUpdateLock({
      fs,
      now: () => now,
      pid: 202,
      isPidAlive: () => true,
      randomToken: () => 'contender-token',
      staleAfterMs: 100,
      useWorkerHeartbeat: false,
      durability: { fsyncFile: () => {} },
    });
    assert.throws(() => contender.acquire(path), /already held/i);
    assert.equal(JSON.parse(fs.readFileSync(path, 'utf8')).token, 'owner-token');

    now = 250;
    assert.equal(contender.acquire(path).token, 'contender-token');
  });

  it('reports a missing lock as a fenced owner instead of leaking ENOENT', () => {
    const root = makeRoot();
    const path = join(root, 'update.lock');
    const lock = createUpdateLock({
      fs,
      now: () => 1,
      isPidAlive: () => true,
      randomToken: () => 'owner-token',
    });
    const token = lock.acquire(path);
    fs.unlinkSync(path);

    assert.throws(
      () => lock.assertHeld(token, path),
      error => error.code === 'ERR_UPDATE_FENCED',
    );
  });

  it('removes its token-scoped heartbeat on release', () => {
    const root = makeRoot();
    const path = join(root, 'update.lock');
    let now = 1;
    const lock = createUpdateLock({
      fs,
      now: () => now,
      isPidAlive: () => true,
      randomToken: () => 'owner-token',
      useWorkerHeartbeat: false,
      durability: { fsyncFile: () => {} },
    });
    const token = lock.acquire(path);
    now = 2;
    lock.heartbeat(token, path);
    lock.release(token, path);

    assert.equal(fs.existsSync(`${path}.heartbeat-owner-token`), false);
  });
});

describe('durable global update journal', { concurrency: false }, () => {
  it('fsyncs prepared and committed complete state before cleanup', () => {
    const root = makeRoot();
    const path = join(root, 'update-journal.json');
    const syncs = [];
    const journal = createUpdateJournalStore({
      path,
      fs,
      durability: {
        fsyncFile: value => syncs.push(`file:${value}`),
        fsyncDirectory: value => syncs.push(`directory:${value}`),
      },
    });

    journal.write(preparedJournal());
    const committed = journal.write(preparedJournal({ phase: 'committed' }));

    assert.equal(committed.phase, 'committed');
    assert.deepEqual(journal.read().snapshot.config.bytes, Buffer.from('proxy:\n  engine: headroom_lite\n'));
    assert.ok(syncs.some(value => value === `file:${path}.new`));
    assert.ok(syncs.some(value => value === `file:${path}`));
    assert.ok(syncs.some(value => value === `directory:${root}`));
    journal.cleanup();
    assert.equal(fs.existsSync(path), false);
  });

  it('round-trips raw service and supervisor definition bytes losslessly', () => {
    const root = makeRoot();
    const store = createUpdateJournalStore({
      path: join(root, 'update-journal.json'),
      fs,
      durability: { fsyncFile: () => {}, fsyncDirectory: () => {} },
    });
    const journal = preparedJournal();
    journal.snapshot.services = {
      primary: { definition: Buffer.from('<plist>old</plist>\n') },
    };
    journal.snapshot.supervisors = {
      watchdog: { definition: Buffer.from('#!/bin/sh\nold\n') },
    };
    journal.desired.services = {
      primary: { definition: Buffer.from('<plist>new</plist>\n') },
    };
    journal.desired.supervisors = {
      watchdog: { definition: Buffer.from('#!/bin/sh\nnew\n') },
    };

    store.write(journal);
    const restored = store.read();

    assert.deepEqual(restored.snapshot.services.primary.definition, Buffer.from('<plist>old</plist>\n'));
    assert.deepEqual(restored.desired.supervisors.watchdog.definition, Buffer.from('#!/bin/sh\nnew\n'));
  });
});

describe('platform service transaction adapter', { concurrency: false }, () => {
  it('snapshots, quiesces, and restores managed Linux unit definitions through injected boundaries', { skip: process.platform === 'win32' }, async () => {
    const root = makeRoot();
    const home = join(root, 'home');
    const units = join(home, '.config', 'systemd', 'user');
    const primary = join(units, 'myelin-compression.service');
    fs.mkdirSync(units, { recursive: true });
    fs.writeFileSync(primary, '[Service]\nExecStart=/old\n', { mode: 0o640 });
    const commands = [];
    const adapter = createPlatformServiceTransactionAdapter({
      home,
      platform: 'linux',
      fs,
      exec: (file, args) => {
        commands.push([file, args]);
        if (args.includes('is-active')) throw new Error('inactive');
      },
    });

    const snapshot = await adapter.captureServices();
    await adapter.quiesceServices();
    fs.writeFileSync(primary, '[Service]\nExecStart=/new\n');
    await adapter.restoreServiceDefinitions(snapshot);

    assert.equal(fs.readFileSync(primary, 'utf8'), '[Service]\nExecStart=/old\n');
    assert.ok(commands.some(([file, args]) => (
      file === 'systemctl' && args.includes('disable') && args.includes('myelin-compression.service')
    )));
  });

  it('uses WinSW process state and disables scheduled watchdog tasks during quiesce', async () => {
    const root = makeRoot();
    const commands = [];
    const adapter = createPlatformServiceTransactionAdapter({
      home: join(root, 'windows-home'),
      platform: 'win32',
      fs,
      exec: (file, args) => {
        commands.push([file, args]);
        const script = args.at(-1) ?? '';
        if (script.includes('$names = @(')) {
          return [
            'MyelinCompression=',
            'MyelinCopilotCompression=',
            'MyelinMitmproxy=',
          ].join('\n');
        }
        if (script.includes('Export-ScheduledTask')) {
          return '__MYELIN_TASK_ABSENT__';
        }
        throw new Error('not running');
      },
    });

    await adapter.captureServices();
    await adapter.quiesceServices();
    await adapter.quiesceSupervisors();

    const scripts = commands
      .filter(([file]) => file === 'powershell.exe')
      .map(([, args]) => args.at(-1));
    assert.ok(scripts.some(script => script.includes('$servicePid =')));
    assert.equal(scripts.some(script => script.includes('$pid =')), false);
    assert.ok(scripts.some(script => script.includes('Disable-ScheduledTask')));
  });

  it('fails closed when Windows Run-key state cannot be snapshotted', async () => {
    const adapter = createPlatformServiceTransactionAdapter({
      home: join(makeRoot(), 'windows-home'),
      platform: 'win32',
      fs,
      exec: () => {
        throw new Error('PowerShell unavailable');
      },
    });

    await assert.rejects(
      () => adapter.captureServices(),
      /Unable to snapshot managed Windows Run-key entries/u,
    );
  });
});

describe('activation and recovery state machine', { concurrency: false }, () => {
  it('persists the prepared journal before quiescing active state', async () => {
    const events = [];
    const result = await activateUpdate(
      {
        ...planUpdate({
          config: { proxy: { engine: 'headroom_lite' } },
          manifest: {
            headroomLite: {
              kind: 'npm-git',
              package: 'github:yehsuf/headroom-lite',
              version: '0.31.0',
              ref: 'v0.31.0',
              bin: 'headroom-lite',
            },
          },
          target: { version: '1.1.0' },
        }),
        stagedRelease: { version: '1.1.0', directory: '/managed/releases/1.1.0' },
      },
      baseDeps(events),
    );

    assert.equal(result.ok, true);
    assert.ok(events.indexOf('journal:prepared') < events.indexOf('quiesce-services'));
    assert.ok(events.indexOf('quiesce-supervisors') < events.indexOf('quiesce-services'));
    assert.ok(events.indexOf('quiesce-supervisors') < events.indexOf('apply-components'));
    assert.ok(events.indexOf('apply-release') < events.indexOf('staged-apply'));
    assert.ok(events.indexOf('journal:committed') < events.indexOf('cleanup-journal'));
  });

  it('cleans inactive partial staging without changing active state on staging failure', async () => {
    const events = [];
    const deps = baseDeps(events);
    deps.stageComponents = async () => {
      events.push('stage-components');
      throw new Error('immutable staging failed');
    };
    const result = await activateUpdate({ stagedRelease: { version: '1.1.0' } }, deps);

    assert.equal(result.status, 'staging-failed');
    assert.deepEqual(events, ['stage-components', 'cleanup-staging']);
  });

  it('stops new services and watchdogs before restoring a prepared snapshot', async () => {
    const events = [];
    const deps = baseDeps(events);
    const journal = preparedJournal();
    deps.readJournal = async () => journal;
    deps.cleanupJournal = async () => events.push('cleanup-journal');

    const result = await recoverUpdateJournal(deps);

    assert.equal(result.status, 'recovered-prepared');
    assert.equal(events[0], 'stop-new');
    assert.ok(events.indexOf('stop-new') < events.indexOf('restore-release'));
    assert.ok(events.indexOf('restore-release') < events.indexOf('restore-services'));
    assert.ok(events.indexOf('restore-services') < events.indexOf('restore-service-status'));
  });

  it('repairs committed desired state forward before journal cleanup', async () => {
    const events = [];
    const deps = baseDeps(events);
    const journal = preparedJournal({ phase: 'committed' });
    deps.readJournal = async () => journal;
    deps.ensureDesiredState = async state => {
      events.push(`repair:${state.release.current}`);
      return true;
    };
    deps.cleanupJournal = async () => events.push('cleanup-journal');

    const result = await recoverUpdateJournal(deps);

    assert.equal(result.status, 'recovered-committed');
    assert.deepEqual(events, ['repair:1.1.0', 'cleanup-journal']);
  });

  it('restores exact config bytes and platform metadata during rollback', async () => {
    const events = [];
    let restored;
    const snapshot = completeState();
    const deps = baseDeps(events);
    deps.restoreConfig = async config => {
      restored = config;
      events.push('restore-config');
    };

    await rollbackUpdate(snapshot, deps);

    assert.deepEqual(restored.bytes, snapshot.config.bytes);
    assert.equal(restored.mode, 0o640);
    assert.deepEqual(restored.metadata.acl, { entries: ['user:me:rw'] });
    assert.deepEqual(restored.metadata.attributes, { hidden: false });
  });

  it('restores exact release and component pairs plus service and watchdog snapshots', async () => {
    const events = [];
    const snapshot = completeState();
    let release;
    let components;
    let services;
    let supervisors;
    const deps = baseDeps(events);
    deps.restoreReleasePair = async value => { release = value; events.push('restore-release'); };
    deps.restoreComponentPairs = async value => { components = value; events.push('restore-components'); };
    deps.restoreServiceDefinitions = async value => { services = value; events.push('restore-services'); };
    deps.restoreSupervisors = async value => { supervisors = value; events.push('restore-supervisors'); };

    await rollbackUpdate(snapshot, deps);

    assert.deepEqual(release, snapshot.release);
    assert.deepEqual(components, snapshot.components);
    assert.deepEqual(services, snapshot.services);
    assert.deepEqual(supervisors, snapshot.supervisors);
    assert.equal(events[0], 'stop-new');
  });

  it('fails closed and retains the journal when rollback restoration fails', async () => {
    const deps = baseDeps([]);
    deps.restoreReleasePair = async () => { throw new Error('cannot restore pointer'); };
    let retained = false;
    deps.retainJournal = async () => { retained = true; };

    await assert.rejects(
      () => rollbackUpdate(completeState(), deps),
      /rollback recovery failed/i,
    );
    assert.equal(retained, true);
  });

  it('rolls back after a staged-release handoff failure', async () => {
    const events = [];
    const deps = baseDeps(events);
    deps.runStagedApply = async () => {
      events.push('staged-apply');
      throw new Error('staged apply failed');
    };
    const plan = {
      ...planUpdate({
        config: { proxy: { engine: 'headroom_lite' } },
        manifest: {
          headroomLite: {
            kind: 'npm-git',
            package: 'github:yehsuf/headroom-lite',
            version: '0.31.0',
            ref: 'v0.31.0',
            bin: 'headroom-lite',
          },
        },
        target: { version: '1.1.0' },
      }),
      stagedRelease: { version: '1.1.0', directory: '/managed/releases/1.1.0' },
    };

    const result = await activateUpdate(plan, deps);

    assert.equal(result.status, 'rolled-back');
    assert.ok(events.indexOf('stop-new') > events.indexOf('staged-apply'));
    assert.ok(events.includes('restore-release'));
  });

  it('retains a committed journal instead of rolling back after cleanup fails', async () => {
    const events = [];
    const deps = baseDeps(events);
    let retained = false;
    deps.cleanupJournal = async journal => {
      events.push(`cleanup:${journal.phase}`);
      if (journal.phase === 'committed') throw new Error('journal cleanup failed');
    };
    deps.retainJournal = async journal => {
      retained = journal.phase === 'committed';
    };
    const plan = {
      ...planUpdate({
        config: { proxy: { engine: 'headroom_lite' } },
        manifest: {
          headroomLite: {
            kind: 'npm-git',
            package: 'github:yehsuf/headroom-lite',
            version: '0.31.0',
            ref: 'v0.31.0',
            bin: 'headroom-lite',
          },
        },
        target: { version: '1.1.0' },
      }),
      stagedRelease: { version: '1.1.0', directory: '/managed/releases/1.1.0' },
    };

    const result = await activateUpdate(plan, deps);

    assert.equal(result.status, 'committed-cleanup-pending');
    assert.equal(retained, true);
    assert.equal(events.includes('stop-new'), false);
  });
});

describe('strict health verification', { concurrency: false }, () => {
  it('rejects a wrong backend and respects per-service and total deadlines', async () => {
    const events = [];
    let now = 0;
    const deps = baseDeps(events);
    deps.requiredServices = () => [{
      name: 'primary',
      backend: 'headroom-lite',
    }];
    deps.verifyService = async () => ({
      ok: true,
      backend: 'headroom-original',
    });
    deps.now = () => now;
    deps.sleep = async milliseconds => { now += milliseconds; };
    deps.healthRetryMs = 10_000;
    deps.perServiceHealthDeadlineMs = 30_000;
    deps.totalHealthDeadlineMs = 120_000;
    const plan = {
      ...planUpdate({
        config: { proxy: { engine: 'headroom_lite' } },
        manifest: {},
        target: { version: '1.1.0' },
      }),
      stagedRelease: { version: '1.1.0', directory: '/managed/releases/1.1.0' },
    };

    const result = await activateUpdate(plan, deps);

    assert.equal(result.status, 'rolled-back');
    assert.ok(now >= 30_000);
    assert.ok(now <= 120_000);
  });
});

describe('finding 4: staged-apply child identity is durably recorded before spawn', { concurrency: false }, () => {
  function activatePlan() {
    return {
      ...planUpdate({
        config: { proxy: { engine: 'headroom_lite' } },
        manifest: {
          headroomLite: {
            kind: 'npm-git',
            package: 'github:yehsuf/headroom-lite',
            version: '0.31.0',
            ref: 'v0.31.0',
            bin: 'headroom-lite',
          },
        },
        target: { version: '1.1.0' },
      }),
      stagedRelease: { version: '1.1.0', directory: '/managed/releases/1.1.0' },
    };
  }

  it('writes an unresolved child marker before spawning and records the pid', async () => {
    const events = [];
    const deps = baseDeps(events);
    const journals = [];
    deps.writeJournal = async journal => {
      events.push(`journal:${journal.phase}`);
      journals.push(journal);
    };
    let markerAtSpawn;
    deps.runStagedApply = async ({ onChildSpawn }) => {
      events.push('staged-apply');
      // A durable marker must already exist before the child does any work.
      markerAtSpawn = journals.at(-1);
      if (onChildSpawn) await onChildSpawn({ pid: 4242 });
    };

    const result = await activateUpdate(activatePlan(), deps);
    assert.equal(result.ok, true);

    // (1) A prepared-phase journal carrying an unresolved child marker was
    //     persisted before runStagedApply ran.
    assert.ok(markerAtSpawn, 'a journal must be written before the staged apply');
    assert.ok(markerAtSpawn.unresolvedChild, 'unresolved child marker must precede spawn');
    assert.equal(markerAtSpawn.unresolvedChild.resolved, false);
    assert.equal(markerAtSpawn.phase, 'prepared');

    // (2) The concrete child pid was durably recorded.
    assert.ok(
      journals.some(journal => journal.unresolvedChild?.pid === 4242),
      'the staged child pid must be durably recorded',
    );

    // (3) After a clean child exit the marker is resolved so later recovery
    //     does not block forever on a defunct pid.
    const lastWithChild = [...journals].reverse().find(journal => journal.unresolvedChild);
    assert.equal(lastWithChild.unresolvedChild.resolved, true);
  });

  it('defers recovery while a recorded staged child is still alive', async () => {
    const events = [];
    const deps = baseDeps(events);
    const journal = preparedJournal({
      unresolvedChild: {
        pid: 4242,
        resolved: false,
        recordedAt: Date.now(),
        reason: 'staged apply in progress',
      },
    });
    deps.readJournal = async () => journal;
    deps.isStagedChildAlive = async () => true;

    await assert.rejects(
      () => recoverUpdateJournal(deps),
      error => {
        assert.equal(error.code, 'ERR_UPDATE_RECOVERY_CHILD_ALIVE');
        return true;
      },
    );
    assert.equal(events.includes('restore-release'), false, 'must not roll back while child alive');
  });
})

// ─── Integration test: syncReleasePair syncs both pointer systems ─────────────
import { tmpdir } from 'node:os';
import { mkdtempSync, symlinkSync, readlinkSync, realpathSync } from 'node:fs';
import { syncReleasePair } from '../src/update/update-orchestrator.mjs';
import { readCurrentRelease } from '../src/runtime/release-store.mjs';

describe('syncReleasePair', { concurrency: false }, () => {
  // Windows: directory symlinks require elevated privileges or Developer Mode;
  // skip the symlink-creating tests on win32.
  const skipOnWindows = process.platform === 'win32';

  it('writes current.json and updates the current symlink atomically', { skip: skipOnWindows }, async () => {
    const home = mkdtempSync(join(tmpdir(), 'sync-release-pair-'));
    try {
      const releasesRoot = join(home, '.myelin', 'releases');
      const oldId = 'main-abcdef1234567890abcdef1234567890abcdef12';
      const newId = 'main-1234567890abcdef1234567890abcdef12345678';
      fs.mkdirSync(join(releasesRoot, oldId), { recursive: true });
      fs.mkdirSync(join(releasesRoot, newId), { recursive: true });

      // Bootstrap: old release active
      await syncReleasePair(
        { current: oldId, previous: null },
        { releasesRoot, home, platform: 'linux' },
      );
      assert.equal(readCurrentRelease({ home })?.releaseId, oldId,
        'current.json should point to old release after bootstrap');

      // Activate: new release
      await syncReleasePair(
        { current: newId, previous: oldId },
        { releasesRoot, home, platform: 'linux' },
      );

      // Both pointer systems must agree
      const jsonRelease = readCurrentRelease({ home });
      const symlinkTarget = realpathSync(join(home, '.myelin', 'current'));
      const expectedRoot = realpathSync(join(releasesRoot, newId));

      assert.equal(jsonRelease?.releaseId, newId,
        'current.json must point to new release');
      assert.equal(symlinkTarget, expectedRoot,
        'current symlink must resolve to new release dir');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('keeps current.json in sync when called from restoreReleasePair scenario', { skip: skipOnWindows }, async () => {
    const home = mkdtempSync(join(tmpdir(), 'sync-release-restore-'));
    try {
      const releasesRoot = join(home, '.myelin', 'releases');
      const newId = 'main-1234567890abcdef1234567890abcdef12345678';
      const oldId = 'main-abcdef1234567890abcdef1234567890abcdef12';
      fs.mkdirSync(join(releasesRoot, newId), { recursive: true });
      fs.mkdirSync(join(releasesRoot, oldId), { recursive: true });

      // Simulate: current was newId but rolled back to oldId
      await syncReleasePair(
        { current: newId, previous: null },
        { releasesRoot, home, platform: 'linux' },
      );
      await syncReleasePair(
        { current: oldId, previous: newId },
        { releasesRoot, home, platform: 'linux' },
      );

      assert.equal(readCurrentRelease({ home })?.releaseId, oldId,
        'current.json must follow symlink after rollback');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// WIN-HEADROOM-FALLBACK-001: auto-switch to headroom-lite when headroom-original
// optional component fails to stage
// ---------------------------------------------------------------------------
describe('WIN-HEADROOM-FALLBACK-001: backend fallback on optional stage failure', { concurrency: false }, () => {
  const manifestWithOptionalOriginal = {
    headroomLite: {
      kind: 'npm-git',
      package: 'github:yehsuf/headroom-lite',
      version: '0.31.0',
      ref: 'v0.31.0',
      bin: 'headroom-lite',
    },
    headroomOriginal: {
      kind: 'uv-venv',
      package: 'headroom-ai[proxy]',
      version: '0.31.0',
      bin: 'headroom',
      optional: true,
      noBuildOnPlatforms: ['win32'],
    },
  };

  it('switches backend to headroom-lite when headroom-original optional stage fails', async () => {
    const events = [];
    const configWritten = [];
    const deps = baseDeps(events);
    // Override stageComponent to fail for headroomOriginal
    deps.stageComponent = async ({ name }) => {
      events.push(`stage:${name}`);
      if (name === 'headroomOriginal') throw new Error('uv pip install failed: ast-grep-cli Defender blocked');
    };
    deps.writeConfig = async (config) => {
      events.push('write-config');
      configWritten.push(config);
    };
    deps.readStagedManifest = async () => manifestWithOptionalOriginal;

    const plan = {
      ...planUpdate({
        config: { compression: { backend: 'headroom-original' } },
        manifest: manifestWithOptionalOriginal,
        target: { version: '1.1.0' },
      }),
      stagedRelease: { version: '1.1.0', directory: '/managed/releases/1.1.0' },
      desiredConfig: {
        exists: true,
        bytes: Buffer.from('compression:\n  backend: headroom-original\n', 'utf8'),
        mode: 0o600,
        metadata: {},
      },
    };

    const result = await activateUpdate(plan, deps);

    assert.equal(result.ok, true);
    assert.equal(result.plan.backend, 'headroom-lite', 'result plan should reflect fallback backend');
    assert.equal(result.plan.config.compression.backend, 'headroom-lite');
    // headroomOriginal must be removed from components so applyComponentPairs
    // does not try to activate a version directory that was never staged.
    const names = (result.plan.components ?? []).map(c => c.name);
    assert.equal(names.includes('headroomOriginal'), false, 'headroomOriginal removed from plan.components');
  });

  it('writes headroom-lite into the desired config bytes on fallback', async () => {
    const load = (await import('js-yaml')).load;
    const events = [];
    const writtenConfigs = [];
    const deps = baseDeps(events);
    deps.stageComponent = async ({ name }) => {
      if (name === 'headroomOriginal') throw new Error('install failed');
    };
    deps.writeConfig = async (rawConfig) => { writtenConfigs.push(rawConfig); };
    deps.readStagedManifest = async () => manifestWithOptionalOriginal;

    const plan = {
      ...planUpdate({
        config: { compression: { backend: 'headroom-original' } },
        manifest: manifestWithOptionalOriginal,
        target: { version: '1.1.0' },
      }),
      stagedRelease: { version: '1.1.0', directory: '/managed/releases/1.1.0' },
      desiredConfig: {
        exists: true,
        bytes: Buffer.from('compression:\n  backend: headroom-original\n', 'utf8'),
        mode: 0o600,
        metadata: {},
      },
    };

    await activateUpdate(plan, deps);

    assert.ok(writtenConfigs.length > 0, 'writeConfig should be called');
    const lastConfig = writtenConfigs.at(-1);
    if (lastConfig?.bytes) {
      const parsed = load(lastConfig.bytes.toString('utf8'));
      assert.equal(parsed?.compression?.backend, 'headroom-lite',
        'written config bytes should have headroom-lite as backend');
    }
  });

  it('does not fallback when a non-optional component fails', async () => {
    const events = [];
    const deps = baseDeps(events);
    const manifest = {
      headroomOriginal: {
        kind: 'uv-venv',
        package: 'headroom-ai[proxy]',
        version: '0.31.0',
        bin: 'headroom',
        // NO optional: true
      },
    };
    deps.stageComponent = async ({ name }) => {
      if (name === 'headroomOriginal') throw new Error('non-optional failure');
    };
    deps.readStagedManifest = async () => manifest;

    const plan = {
      ...planUpdate({
        config: { compression: { backend: 'headroom-original' } },
        manifest,
        target: { version: '1.1.0' },
      }),
      stagedRelease: { version: '1.1.0', directory: '/managed/releases/1.1.0' },
    };

    const result = await activateUpdate(plan, deps);
    assert.equal(result.status, 'staging-failed');
  });
});
