import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  runKeyLauncherPath,
  launcherOwnedByManagedRoot,
  runKeyOwnershipDecision,
} from '../src/service/windows.mjs';
import { managedHeadroomRegistrationStatus, planManagedRelocationMigration } from '../src/install.mjs';

const HOME = 'C:\\Users\\alice';

describe('I6(b) Run-key launcher ownership verification', () => {
  it('extracts the launcher from a -File launcher Run-key value', () => {
    const value = 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "C:\\Users\\alice\\.myelin\\services\\myelin-compression\\start-headroom.ps1"';
    assert.equal(runKeyLauncherPath(value), 'C:\\Users\\alice\\.myelin\\services\\myelin-compression\\start-headroom.ps1');
  });

  it('extracts the executable from a legacy quoted direct-exe Run-key value', () => {
    const value = '"C:\\Users\\alice\\.myelin\\bin\\headroom.exe" proxy --port 8787';
    assert.equal(runKeyLauncherPath(value), 'C:\\Users\\alice\\.myelin\\bin\\headroom.exe');
  });

  it('KEEPS a Run key whose launcher lives under the current default managed root', () => {
    const value = 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "C:\\Users\\alice\\.myelin\\services\\myelin-compression\\start-headroom.ps1"';
    assert.equal(launcherOwnedByManagedRoot({ runKeyValue: value, home: HOME, env: {} }), true);
    assert.equal(runKeyOwnershipDecision({ runKeyValue: value, home: HOME, env: {} }), 'keep');
  });

  it('RE-REGISTERS a Run key whose launcher points at a DIFFERENT (relocated) root', () => {
    // Run key still points at the old default ~/.myelin, but the current managed
    // root has been relocated to D:\myelin — the stale key must not be trusted.
    const value = 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "C:\\Users\\alice\\.myelin\\services\\myelin-compression\\start-headroom.ps1"';
    const env = { MYELIN_DIR: 'D:\\myelin' };
    assert.equal(launcherOwnedByManagedRoot({ runKeyValue: value, home: HOME, env }), false);
    assert.equal(runKeyOwnershipDecision({ runKeyValue: value, home: HOME, env }), 'reregister');
  });

  it('matches ownership against an explicit managedRoot regardless of separator/case noise', () => {
    const value = 'powershell.exe -File "D:\\Myelin\\services\\myelin-compression\\start-headroom.ps1"';
    assert.equal(launcherOwnedByManagedRoot({ runKeyValue: value, managedRoot: 'D:\\myelin\\' }), true);
    assert.equal(launcherOwnedByManagedRoot({ runKeyValue: value, managedRoot: 'D:\\other' }), false);
  });

  it("treats an absent Run key as 'absent'", () => {
    assert.equal(runKeyOwnershipDecision({ runKeyValue: '' }), 'absent');
  });

  it('managedHeadroomRegistrationStatus KEEPS a Run key owned by the current root and RE-REGISTERS a foreign one', async () => {
    const currentRootValue = 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "D:\\myelin\\services\\myelin-compression\\start-headroom.ps1"';
    const foreignRootValue = 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "C:\\Users\\alice\\.myelin\\services\\myelin-compression\\start-headroom.ps1"';
    const env = { MYELIN_DIR: 'D:\\myelin' };

    const kept = await managedHeadroomRegistrationStatus({
      os: 'windows',
      winManager: 'registry',
      home: HOME,
      env,
      runKeyStatusImpl: () => ({ registered: true, raw: currentRootValue }),
    });
    assert.equal(kept.registered, true);
    assert.equal(kept.foreignRoot, false);

    const foreign = await managedHeadroomRegistrationStatus({
      os: 'windows',
      winManager: 'registry',
      home: HOME,
      env,
      runKeyStatusImpl: () => ({ registered: true, raw: foreignRootValue }),
    });
    assert.equal(foreign.registered, false, 'stale foreign-root Run key must not count as registered');
    assert.equal(foreign.foreignRoot, true);
  });
});

describe('I6(a) relocation-migration detection + decision', () => {
  it('is a no-op for a default (non-relocated) install', () => {
    const plan = planManagedRelocationMigration({ home: HOME, env: {}, platform: 'windows', existsSyncImpl: () => true });
    assert.equal(plan.relocated, false);
    assert.equal(plan.shouldMigrate, false);
    assert.equal(plan.reason, 'not-relocated');
  });

  it('MIGRATES when relocated, the default root holds state, and the new root is empty', () => {
    const defaultRoot = 'C:\\Users\\alice\\.myelin';
    const plan = planManagedRelocationMigration({
      home: HOME,
      env: { MYELIN_DIR: 'D:\\myelin' },
      platform: 'windows',
      existsSyncImpl: (p) => p === defaultRoot, // default exists, relocated does not
    });
    assert.equal(plan.relocated, true);
    assert.equal(plan.shouldMigrate, true);
    assert.equal(plan.from, defaultRoot);
    assert.equal(plan.to, 'D:\\myelin');
    assert.deepEqual(plan.sources, [
      'C:\\Users\\alice\\.myelin\\releases',
      'C:\\Users\\alice\\.myelin\\current.json',
      'C:\\Users\\alice\\.myelin\\config.yaml',
    ]);
    assert.equal(plan.reason, 'migrate-default-to-relocated');
  });

  it('does NOT migrate when the relocated root is already populated', () => {
    const plan = planManagedRelocationMigration({
      home: HOME,
      env: { MYELIN_DIR: 'D:\\myelin' },
      platform: 'windows',
      existsSyncImpl: () => true, // both exist -> relocated already has state
    });
    assert.equal(plan.relocated, true);
    assert.equal(plan.shouldMigrate, false);
    assert.equal(plan.reason, 'relocated-root-populated');
  });

  it('does NOT migrate when there is no default state to move', () => {
    const plan = planManagedRelocationMigration({
      home: HOME,
      env: { MYELIN_DIR: 'D:\\myelin' },
      platform: 'windows',
      existsSyncImpl: () => false, // neither exists
    });
    assert.equal(plan.relocated, true);
    assert.equal(plan.shouldMigrate, false);
    assert.equal(plan.reason, 'no-default-state');
  });
});
