import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { installWinswService, isWindowsSharingViolation } from '../src/service/windows.mjs';

const BASE = {
  id: 'headroom-primary',
  name: 'Myelin Headroom Primary',
  description: 'Myelin headroom primary',
  executable: 'C:\\Users\\alice\\.myelin\\venv\\Scripts\\headroom.exe',
  arguments: 'proxy --port 8787',
  logPath: 'C:\\Users\\alice\\.myelin\\headroom-primary.log',
  home: 'C:\\Users\\alice',
  isWslImpl: () => true,
  installWinswImpl: async () => ({
    path: 'C:\\Users\\alice\\.myelin\\bin\\winsw.exe',
    filesystemPath: '/mnt/c/Users/alice/.myelin/bin/winsw.exe',
  }),
};

function sharingViolation(message = 'The process cannot access the file because it is being used by another process. (error 32)') {
  const err = new Error(message);
  err.code = 'EBUSY';
  err.winError = 32;
  return err;
}

describe('I9 installWinswService reinstall never overwrites the running exe', () => {
  it('detects Windows sharing violations from code, winError, and message', () => {
    assert.equal(isWindowsSharingViolation(sharingViolation()), true);
    assert.equal(isWindowsSharingViolation(Object.assign(new Error('Access is denied'), { winError: 5 })), true);
    assert.equal(isWindowsSharingViolation(Object.assign(new Error('nope'), { code: 'ENOENT' })), false);
    assert.equal(isWindowsSharingViolation(null), false);
  });

  it('retries the staged->live rename on error 32 with backoff, then succeeds without touching the live exe until the handle is free', async () => {
    let exeRenameAttempts = 0;
    const sleeps = [];
    const psScripts = [];
    const unlinked = [];
    const copies = [];

    const result = await installWinswService({
      ...BASE,
      mkdirSyncImpl: () => {},
      // A previous service exe is present (reinstall path); .new/.bak/.xml absent.
      existsSyncImpl: (p) => p.endsWith('headroom-primary.exe'),
      copyFileSyncImpl: (from, to) => copies.push({ from, to }),
      writeFileSyncImpl: () => {},
      renameSyncImpl: (from) => {
        if (from.endsWith('.exe.new')) {
          exeRenameAttempts += 1;
          if (exeRenameAttempts < 3) throw sharingViolation();
        }
      },
      unlinkSyncImpl: (p) => unlinked.push(p),
      sleepImpl: async (ms) => { sleeps.push(ms); },
      replaceBackoffMs: 10,
      runPsFn: (script) => psScripts.push(script),
    });

    // The new exe is copied to a *staged* .new path, never straight onto the live exe.
    assert.ok(copies.some(({ to }) => to.endsWith('headroom-primary.exe.new')));
    assert.ok(!copies.some(({ to }) => to === '/mnt/c/Users/alice/.myelin/services/headroom-primary/headroom-primary.exe'));
    // Rename retried 3x (2 failures + success) with a backoff between each attempt.
    assert.equal(exeRenameAttempts, 3);
    assert.deepEqual(sleeps, [10, 20]);
    // Old service uninstalled first, new one installed last -> host never serviceless.
    assert.match(psScripts[0], /uninstall/);
    assert.match(psScripts.at(-1), /\bstart\b/);
    // Backup of the previous exe is discarded on success.
    assert.ok(unlinked.some((p) => p.endsWith('headroom-primary.exe.bak')));
    assert.equal(result.id, 'headroom-primary');
  });

  it('restores the previous service and re-registers it when the staged rename never succeeds (never leaves the host serviceless)', async () => {
    let restoredExe = false;
    const psScripts = [];
    const unlinked = [];

    await assert.rejects(installWinswService({
      ...BASE,
      mkdirSyncImpl: () => {},
      existsSyncImpl: (p) => p.endsWith('headroom-primary.exe'),
      copyFileSyncImpl: () => {},
      writeFileSyncImpl: () => {},
      renameSyncImpl: (from, to) => {
        if (from.endsWith('.exe.new')) throw sharingViolation('sharing violation (error 32)');
        if (from.endsWith('.exe.bak') && to.endsWith('headroom-primary.exe')) { restoredExe = true; return; }
      },
      unlinkSyncImpl: (p) => unlinked.push(p),
      sleepImpl: async () => {},
      replaceAttempts: 3,
      runPsFn: (script) => psScripts.push(script),
    }), /error 32|sharing violation|being used by another process/i);

    // The backed-up previous exe was moved back into place...
    assert.ok(restoredExe, 'previous exe restored from .bak');
    // ...and the previous service re-registered (install+start) so it keeps running.
    assert.match(psScripts.at(-1), /\bstart\b/);
    // Staged candidate files cleaned up.
    assert.ok(unlinked.some((p) => p.endsWith('headroom-primary.exe.new')));
    assert.ok(unlinked.some((p) => p.endsWith('headroom-primary.xml.new')));
  });
});
