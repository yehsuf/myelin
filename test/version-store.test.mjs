import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  closeSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join, posix, win32 } from 'node:path';
import {
  activateComponent,
  componentVersionDir,
  readPointers,
  readPointersReadOnly,
  restoreComponent,
} from '../src/update/version-store.mjs';

const temporaryRoots = [];

function makeRoot() {
  const root = mkdtempSync(join(process.cwd(), '.test-version-store-'));
  temporaryRoots.push(root);
  return root;
}

function createVersion(root, name, version) {
  const directory = componentVersionDir(root, name, version);
  mkdirSync(directory, { recursive: true });
  return directory;
}

function testFs(overrides = {}) {
  return {
    existsSync,
    closeSync,
    fsyncSync,
    linkSync,
    lstatSync,
    mkdirSync,
    openSync,
    readFileSync,
    readlinkSync,
    renameSync,
    rmdirSync,
    rmSync,
    statSync,
    symlinkSync,
    unlinkSync,
    writeFileSync,
    ...overrides,
  };
}

function noOpDurability() {
  return {
    fsyncDirectory() {},
    fsyncFile() {},
  };
}

function transactionJournalPath(root, name) {
  return join(root, name, '.pointer-store-journal.json');
}

function writeTransactionJournal(root, name, {
  snapshot,
  desired,
  phase,
  cleanupState = 'pending',
  repairPrevious = false,
}) {
  writeFileSync(transactionJournalPath(root, name), JSON.stringify({
    schemaVersion: 1,
    name,
    snapshot,
    desired,
    phase,
    cleanupState,
    repairPrevious,
  }), 'utf8');
}

function createPointer(root, name, pointer, target) {
  symlinkSync(target, join(root, name, pointer), 'dir');
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('versioned component store', () => {
  it('builds a component version directory below its component root', () => {
    assert.equal(
      componentVersionDir('/components', 'rtk', '0.44.0'),
      join('/components', 'rtk', '0.44.0'),
    );
  });

  it('builds the version directory using an injected platform-specific path module instead of the host path module', () => {
    // component-installers.mjs threads an explicit `platform` through
    // buildComponentInstallPlan/pathFor so that callers can target a platform
    // other than the host (this is exactly what the component-installers.test.mjs
    // "staging and managed detection" suite simulates by passing
    // `platform: { os: 'linux' }` while running on Windows CI). componentVersionDir
    // is the first path-building step in that pipeline, so it must honor the same
    // platform-specific path module rather than silently defaulting to the host's
    // node:path module (which is win32 on a real Windows machine and posix
    // everywhere else). Otherwise a destination built for a non-host platform comes
    // out in the *host's* separator style, and downstream posix/win32 path
    // operations on that malformed string silently diverge (e.g. posix.dirname of a
    // win32-only path collapses to '.').
    assert.equal(
      componentVersionDir('/components', 'rtk', '0.44.0', win32),
      win32.join('/components', 'rtk', '0.44.0'),
    );
    assert.equal(
      componentVersionDir('C:\\components', 'rtk', '0.44.0', posix),
      posix.join('C:\\components', 'rtk', '0.44.0'),
    );
  });

  it('rejects activation when the target version directory does not exist', () => {
    const root = makeRoot();

    assert.throws(
      () => activateComponent({ root, name: 'rtk', version: '0.44.0', platform: 'linux' }),
      /target version directory.*does not exist/i,
    );
    assert.deepEqual(readPointers(root, 'rtk'), { current: null, previous: null });
  });

  it('downgrades by switching current while retaining the newer directory', () => {
    const root = makeRoot();
    createVersion(root, 'rtk', '0.44.0');
    createVersion(root, 'rtk', '0.43.0');

    activateComponent({ root, name: 'rtk', version: '0.44.0', platform: 'linux' });
    activateComponent({ root, name: 'rtk', version: '0.43.0', platform: 'linux' });

    assert.deepEqual(readPointers(root, 'rtk'), {
      current: '0.43.0',
      previous: '0.44.0',
    });
    assert.equal(existsSync(componentVersionDir(root, 'rtk', '0.44.0')), true);
  });

  it('inspects pointers without acquiring the component lock', () => {
    const root = makeRoot();
    createVersion(root, 'rtk', '0.44.0');
    activateComponent({ root, name: 'rtk', version: '0.44.0', platform: 'linux' });
    const lock = {
      acquire() {
        throw new Error('read-only inspection must not acquire');
      },
    };

    assert.deepEqual(
      readPointersReadOnly(root, 'rtk', { lock }),
      { current: '0.44.0', previous: null },
    );
  });

  it('does not switch a component with a missing captured current target', () => {
    const root = makeRoot();
    createVersion(root, 'rtk', '0.43.0');
    createVersion(root, 'rtk', '0.44.0');
    activateComponent({ root, name: 'rtk', version: '0.43.0', platform: 'linux' });
    rmSync(componentVersionDir(root, 'rtk', '0.43.0'), { recursive: true });

    assert.throws(
      () => activateComponent({ root, name: 'rtk', version: '0.44.0', platform: 'linux' }),
      /target version directory.*does not exist/i,
    );
    assert.throws(
      () => readPointers(root, 'rtk'),
      /target version directory.*does not exist|broken|invalid/i,
    );
    assert.equal(readlinkSync(join(root, 'rtk', 'current')), '0.43.0');
  });

  it('does not switch a component with a missing captured previous target', () => {
    const root = makeRoot();
    createVersion(root, 'rtk', '0.42.0');
    createVersion(root, 'rtk', '0.43.0');
    createVersion(root, 'rtk', '0.44.0');
    activateComponent({ root, name: 'rtk', version: '0.42.0', platform: 'linux' });
    activateComponent({ root, name: 'rtk', version: '0.43.0', platform: 'linux' });
    rmSync(componentVersionDir(root, 'rtk', '0.42.0'), { recursive: true });

    assert.throws(
      () => activateComponent({ root, name: 'rtk', version: '0.44.0', platform: 'linux' }),
      /target version directory.*does not exist/i,
    );
    assert.throws(
      () => readPointers(root, 'rtk'),
      /target version directory.*does not exist|broken|invalid/i,
    );
    assert.equal(readlinkSync(join(root, 'rtk', 'current')), '0.43.0');
    assert.equal(readlinkSync(join(root, 'rtk', 'previous')), '0.42.0');
  });

  it('uses relative directory symlinks for POSIX pointers', () => {
    const root = makeRoot();
    createVersion(root, 'rtk', '0.44.0');

    activateComponent({ root, name: 'rtk', version: '0.44.0', platform: 'darwin' });

    assert.equal(readlinkSync(join(root, 'rtk', 'current')), '0.44.0');
  });

  it('restores both captured pointers when replacing previous fails', () => {
    const root = makeRoot();
    createVersion(root, 'rtk', '0.42.0');
    createVersion(root, 'rtk', '0.43.0');
    createVersion(root, 'rtk', '0.44.0');
    activateComponent({ root, name: 'rtk', version: '0.42.0', platform: 'linux' });
    activateComponent({ root, name: 'rtk', version: '0.43.0', platform: 'linux' });

    const fs = testFs({
      renameSync(source, destination) {
        if (source.endsWith('previous.new') && destination.endsWith('previous')) {
          throw new Error('simulated previous replacement failure');
        }
        return renameSync(source, destination);
      },
    });

    assert.throws(
      () => activateComponent({
        root,
        name: 'rtk',
        version: '0.44.0',
        platform: 'linux',
        fs,
      }),
      /simulated previous replacement failure/,
    );
    assert.deepEqual(readPointers(root, 'rtk'), {
      current: '0.43.0',
      previous: '0.42.0',
    });
  });

  it('restores a captured pointer state', () => {
    const root = makeRoot();
    createVersion(root, 'rtk', '0.42.0');
    createVersion(root, 'rtk', '0.43.0');
    createVersion(root, 'rtk', '0.44.0');
    activateComponent({ root, name: 'rtk', version: '0.42.0', platform: 'linux' });
    activateComponent({ root, name: 'rtk', version: '0.43.0', platform: 'linux' });

    restoreComponent({
      root,
      name: 'rtk',
      pointers: { current: '0.44.0', previous: '0.43.0' },
      platform: 'linux',
    });

    assert.deepEqual(readPointers(root, 'rtk'), {
      current: '0.44.0',
      previous: '0.43.0',
    });
  });

  it('uses an injected cmd junction command for Windows pointers', () => {
    const root = makeRoot();
    const target = createVersion(root, 'rtk', '0.44.0');
    const temporaryPointer = join(root, 'rtk', 'current.new');
    const commands = [];
    const runCommand = (command, commandArguments) => {
      commands.push({ command, arguments: commandArguments });
      symlinkSync(target, temporaryPointer, 'dir');
    };

    activateComponent({
      root,
      name: 'rtk',
      version: '0.44.0',
      platform: 'win32',
      runCommand,
    });

    assert.deepEqual(commands, [{
      command: 'cmd',
      arguments: [
        '/d',
        '/s',
        '/c',
        `mklink /J "${temporaryPointer}" "${target}"`,
      ],
    }]);
    assert.deepEqual(readPointers(root, 'rtk'), { current: '0.44.0', previous: null });
  });

  it('accepts the extended Windows junction target form while keeping it confined', () => {
    const root = makeRoot();
    const target = createVersion(root, 'rtk', '0.44.0');
    const current = join(root, 'rtk', 'current');
    createPointer(root, 'rtk', 'current', target);
    const fs = testFs({
      readlinkSync(path) {
        if (path === current) return `\\\\?\\${target}`;
        return readlinkSync(path);
      },
    });

    assert.deepEqual(readPointers(root, 'rtk', {
      fs,
      platform: 'win32',
      createJunction: (pointer, target) => symlinkSync(target, pointer, 'dir'),
      durability: noOpDurability(),
    }), {
      current: '0.44.0',
      previous: null,
    });
  });

  it('uses the injected Windows platform for unsupported default directory fsyncs', () => {
    const root = makeRoot();
    createVersion(root, 'rtk', '0.44.0');
    const componentRoot = join(root, 'rtk');
    const fs = testFs({
      openSync(path, flags) {
        if (path === componentRoot) {
          const error = new Error('Windows cannot open a directory handle');
          error.code = 'EPERM';
          throw error;
        }
        return openSync(path, flags);
      },
    });

    activateComponent({
      root,
      name: 'rtk',
      version: '0.44.0',
      platform: 'win32',
      fs,
      createJunction: (pointer, target) => symlinkSync(target, pointer, 'dir'),
    });

    assert.deepEqual(readPointers(root, 'rtk'), {
      current: '0.44.0',
      previous: null,
    });
  });

  it('switches an existing Windows junction when its filesystem rejects overwrite renames', () => {
    const root = makeRoot();
    createVersion(root, 'rtk', '0.43.0');
    createVersion(root, 'rtk', '0.44.0');
    const createJunction = (pointer, target) => symlinkSync(target, pointer, 'dir');
    activateComponent({
      root,
      name: 'rtk',
      version: '0.43.0',
      platform: 'win32',
      createJunction,
    });

    const fs = testFs({
      renameSync(source, destination) {
        if (
          (source.endsWith('current.new') || source.endsWith('previous.new'))
          && existsSync(destination)
        ) {
          const error = new Error('Windows cannot replace an existing junction');
          error.code = 'EPERM';
          throw error;
        }
        return renameSync(source, destination);
      },
    });

    activateComponent({
      root,
      name: 'rtk',
      version: '0.44.0',
      platform: 'win32',
      fs,
      createJunction,
    });

    assert.deepEqual(readPointers(root, 'rtk'), { current: '0.44.0', previous: '0.43.0' });
  });

  it('uses an injected junction creator and restores Windows pointers after a failed switch', () => {
    const root = makeRoot();
    createVersion(root, 'rtk', '0.43.0');
    createVersion(root, 'rtk', '0.44.0');
    const created = [];
    const createJunction = (pointer, target) => {
      created.push({ pointer, target });
      symlinkSync(target, pointer, 'dir');
    };
    activateComponent({
      root,
      name: 'rtk',
      version: '0.43.0',
      platform: 'win32',
      createJunction,
    });

    const fs = testFs({
      renameSync(source, destination) {
        if (source.endsWith('previous.new') && destination.endsWith('previous')) {
          throw new Error('simulated Windows previous replacement failure');
        }
        return renameSync(source, destination);
      },
    });

    assert.throws(
      () => activateComponent({
        root,
        name: 'rtk',
        version: '0.44.0',
        platform: 'win32',
        fs,
        createJunction,
      }),
      /simulated Windows previous replacement failure/,
    );
    assert.deepEqual(readPointers(root, 'rtk'), { current: '0.43.0', previous: null });
    assert.ok(created.every(({ target }) => target.startsWith(join(root, 'rtk'))));
  });

  it('rejects traversal tokens and fails closed for external active pointers', () => {
    const root = makeRoot();
    const external = join(root, 'outside');
    mkdirSync(external);
    createVersion(root, 'rtk', '0.44.0');
    createPointer(root, 'rtk', 'current', external);

    assert.throws(
      () => componentVersionDir(root, '../outside', '0.44.0'),
      /safe token|invalid.*name/i,
    );
    assert.throws(
      () => componentVersionDir(root, 'rtk', 'current.new'),
      /reserved|safe token/i,
    );
    assert.throws(
      () => readPointers(root, 'rtk'),
      /confined|pointer target|invalid/i,
    );
  });

  it('fails closed for a broken active pointer without treating it as absent', () => {
    const root = makeRoot();
    createVersion(root, 'rtk', '0.44.0');
    createPointer(root, 'rtk', 'current', 'missing-version');

    assert.throws(
      () => readPointers(root, 'rtk'),
      /target version directory.*does not exist|broken|invalid/i,
    );
    assert.equal(lstatSync(join(root, 'rtk', 'current')).isSymbolicLink(), true);
  });

  it('repairs a prepared Windows transaction after a crash with .old and .new junction artifacts', () => {
    const root = makeRoot();
    const oldTarget = createVersion(root, 'rtk', '0.43.0');
    const newTarget = createVersion(root, 'rtk', '0.44.0');
    const componentRoot = join(root, 'rtk');
    createPointer(root, 'rtk', 'current.old', oldTarget);
    createPointer(root, 'rtk', 'current.new', newTarget);
    createPointer(root, 'rtk', 'previous.new', oldTarget);
    createPointer(root, 'rtk', 'previous.old', join(componentRoot, 'missing-version'));
    writeTransactionJournal(root, 'rtk', {
      snapshot: { current: '0.43.0', previous: null },
      desired: { current: '0.44.0', previous: '0.43.0' },
      phase: 'prepared',
    });

    assert.deepEqual(readPointers(root, 'rtk', {
      platform: 'win32',
      fs: testFs({
        existsSync() {
          throw new Error('pointer handling must use lstatSync');
        },
      }),
      createJunction: (pointer, target) => symlinkSync(target, pointer, 'dir'),
      durability: noOpDurability(),
    }), {
      current: '0.43.0',
      previous: null,
    });
    assert.equal(existsSync(transactionJournalPath(root, 'rtk')), false);
    assert.equal(existsSync(join(root, 'rtk', 'current.old')), false);
  });

  it('repairs a committed journal to its full desired pointer pair', () => {
    const root = makeRoot();
    const oldTarget = createVersion(root, 'rtk', '0.43.0');
    createVersion(root, 'rtk', '0.44.0');
    createPointer(root, 'rtk', 'current', oldTarget);
    writeTransactionJournal(root, 'rtk', {
      snapshot: { current: '0.43.0', previous: null },
      desired: { current: '0.44.0', previous: '0.43.0' },
      phase: 'committed',
    });

    assert.deepEqual(readPointers(root, 'rtk', {
      durability: noOpDurability(),
    }), {
      current: '0.44.0',
      previous: '0.43.0',
    });
    assert.equal(existsSync(transactionJournalPath(root, 'rtk')), false);
  });

  it('recovers a prepared journal before rejecting a missing activation target', () => {
    const root = makeRoot();
    createVersion(root, 'rtk', '0.43.0');
    createVersion(root, 'rtk', '0.44.0');
    writeTransactionJournal(root, 'rtk', {
      snapshot: { current: '0.43.0', previous: null },
      desired: { current: '0.44.0', previous: '0.43.0' },
      phase: 'prepared',
    });

    assert.throws(
      () => activateComponent({
        root,
        name: 'rtk',
        version: '0.45.0',
        platform: 'linux',
        durability: noOpDurability(),
      }),
      /target version directory.*does not exist/i,
    );
    assert.equal(existsSync(transactionJournalPath(root, 'rtk')), false);
    assert.equal(readlinkSync(join(root, 'rtk', 'current')), '0.43.0');
  });

  it('retains a prepared journal and fails closed when its snapshot cannot be restored', () => {
    const root = makeRoot();
    createVersion(root, 'rtk', '0.43.0');
    createVersion(root, 'rtk', '0.44.0');
    writeTransactionJournal(root, 'rtk', {
      snapshot: { current: '0.43.0', previous: null },
      desired: { current: '0.44.0', previous: '0.43.0' },
      phase: 'prepared',
    });
    rmSync(componentVersionDir(root, 'rtk', '0.43.0'), { recursive: true });

    assert.throws(
      () => readPointers(root, 'rtk', { durability: noOpDurability() }),
      /target version directory.*does not exist/i,
    );
    assert.equal(existsSync(transactionJournalPath(root, 'rtk')), true);
  });

  it('finishes a crashed explicit stale-previous repair from its prepared journal', () => {
    const root = makeRoot();
    const oldTarget = createVersion(root, 'rtk', '0.42.0');
    const currentTarget = createVersion(root, 'rtk', '0.43.0');
    createPointer(root, 'rtk', 'current', currentTarget);
    createPointer(root, 'rtk', 'previous', oldTarget);
    rmSync(oldTarget, { recursive: true });
    writeTransactionJournal(root, 'rtk', {
      snapshot: { current: '0.43.0', previous: null },
      desired: { current: '0.43.0', previous: null },
      phase: 'prepared',
      repairPrevious: true,
    });

    assert.deepEqual(readPointers(root, 'rtk', {
      durability: noOpDurability(),
    }), {
      current: '0.43.0',
      previous: null,
    });
    assert.equal(existsSync(transactionJournalPath(root, 'rtk')), false);
    assert.equal(existsSync(join(root, 'rtk', 'previous')), false);
  });

  it('keeps a committed switch when backup cleanup fails', () => {
    const root = makeRoot();
    createVersion(root, 'rtk', '0.43.0');
    createVersion(root, 'rtk', '0.44.0');
    activateComponent({
      root,
      name: 'rtk',
      version: '0.43.0',
      platform: 'linux',
      durability: noOpDurability(),
    });

    const fs = testFs({
      rmSync(path, options) {
        if (path.endsWith('.old') && existsSync(path)) {
          throw new Error('simulated backup cleanup failure');
        }
        return rmSync(path, options);
      },
    });

    assert.doesNotThrow(() => activateComponent({
      root,
      name: 'rtk',
      version: '0.44.0',
      platform: 'linux',
      fs,
      durability: noOpDurability(),
    }));
    assert.equal(existsSync(transactionJournalPath(root, 'rtk')), true);
    assert.deepEqual(readPointers(root, 'rtk'), {
      current: '0.44.0',
      previous: '0.43.0',
    });
  });

  it('keeps a committed switch when recording completed cleanup fails', () => {
    const root = makeRoot();
    createVersion(root, 'rtk', '0.43.0');
    createVersion(root, 'rtk', '0.44.0');
    activateComponent({
      root,
      name: 'rtk',
      version: '0.43.0',
      platform: 'linux',
      durability: noOpDurability(),
    });

    let journalRenames = 0;
    const fs = testFs({
      renameSync(source, destination) {
        if (
          source.endsWith('.pointer-store-journal.json.new')
          && destination.endsWith('.pointer-store-journal.json')
        ) {
          journalRenames += 1;
          if (journalRenames === 3) {
            throw new Error('simulated completed cleanup journal failure');
          }
        }
        return renameSync(source, destination);
      },
    });

    assert.doesNotThrow(() => activateComponent({
      root,
      name: 'rtk',
      version: '0.44.0',
      platform: 'linux',
      fs,
      durability: noOpDurability(),
    }));
    assert.equal(readlinkSync(join(root, 'rtk', 'current')), '0.44.0');
    assert.equal(readlinkSync(join(root, 'rtk', 'previous')), '0.43.0');
    assert.equal(existsSync(transactionJournalPath(root, 'rtk')), true);
  });

  it('compensates a partial multi-pointer activation and exposes transaction metadata', () => {
    const root = makeRoot();
    createVersion(root, 'rtk', '0.42.0');
    createVersion(root, 'rtk', '0.43.0');
    createVersion(root, 'rtk', '0.44.0');
    activateComponent({
      root,
      name: 'rtk',
      version: '0.42.0',
      platform: 'linux',
      durability: noOpDurability(),
    });
    activateComponent({
      root,
      name: 'rtk',
      version: '0.43.0',
      platform: 'linux',
      durability: noOpDurability(),
    });

    let failed = false;
    const fs = testFs({
      renameSync(source, destination) {
        if (!failed && source.endsWith('previous.new') && destination.endsWith('previous')) {
          failed = true;
          throw new Error('simulated partial pointer install failure');
        }
        return renameSync(source, destination);
      },
    });

    let error;
    try {
      activateComponent({
        root,
        name: 'rtk',
        version: '0.44.0',
        platform: 'linux',
        fs,
        durability: noOpDurability(),
      });
    } catch (caught) {
      error = caught;
    }

    assert.match(error?.message ?? '', /simulated partial pointer install failure/);
    assert.equal(error?.transaction?.compensation?.succeeded, true);
    assert.deepEqual(readPointers(root, 'rtk'), {
      current: '0.43.0',
      previous: '0.42.0',
    });
  });

  it('compensates when recording a committed journal fails after pointer installation', () => {
    const root = makeRoot();
    createVersion(root, 'rtk', '0.42.0');
    createVersion(root, 'rtk', '0.43.0');
    createVersion(root, 'rtk', '0.44.0');
    activateComponent({
      root,
      name: 'rtk',
      version: '0.42.0',
      platform: 'linux',
      durability: noOpDurability(),
    });
    activateComponent({
      root,
      name: 'rtk',
      version: '0.43.0',
      platform: 'linux',
      durability: noOpDurability(),
    });

    let journalRenames = 0;
    const fs = testFs({
      renameSync(source, destination) {
        if (
          source.endsWith('.pointer-store-journal.json.new')
          && destination.endsWith('.pointer-store-journal.json')
        ) {
          journalRenames += 1;
          if (journalRenames === 2) {
            throw new Error('simulated committed journal failure');
          }
        }
        return renameSync(source, destination);
      },
    });

    let error;
    try {
      activateComponent({
        root,
        name: 'rtk',
        version: '0.44.0',
        platform: 'linux',
        fs,
        durability: noOpDurability(),
      });
    } catch (caught) {
      error = caught;
    }

    assert.match(error?.message ?? '', /simulated committed journal failure/);
    assert.equal(error?.transaction?.compensation?.succeeded, true);
    assert.deepEqual(readPointers(root, 'rtk'), {
      current: '0.43.0',
      previous: '0.42.0',
    });
  });

  it('keeps the desired pair active when committed journal durability fails after publication', () => {
    const root = makeRoot();
    createVersion(root, 'rtk', '0.42.0');
    createVersion(root, 'rtk', '0.43.0');
    createVersion(root, 'rtk', '0.44.0');
    activateComponent({
      root,
      name: 'rtk',
      version: '0.42.0',
      platform: 'linux',
      durability: noOpDurability(),
    });
    activateComponent({
      root,
      name: 'rtk',
      version: '0.43.0',
      platform: 'linux',
      durability: noOpDurability(),
    });

    let committedJournalFsyncs = 0;
    const durability = {
      fsyncFile(path) {
        if (path === transactionJournalPath(root, 'rtk')) {
          committedJournalFsyncs += 1;
          if (committedJournalFsyncs === 2) {
            throw new Error('simulated committed journal fsync failure');
          }
        }
      },
      fsyncDirectory() {},
    };

    let error;
    try {
      activateComponent({
        root,
        name: 'rtk',
        version: '0.44.0',
        platform: 'linux',
        durability,
      });
    } catch (caught) {
      error = caught;
    }

    assert.match(error?.message ?? '', /simulated committed journal fsync failure/);
    assert.equal(error?.journalWrite?.published, true);
    assert.equal(error?.journalWrite?.phase, 'committed');
    assert.equal(error?.recovery?.phase, 'committed');
    assert.equal(error?.recovery?.cleanupState, 'pending');
    assert.equal(error?.recovery?.step, 'verify-desired');
    assert.equal(error?.recovery?.journalPublished, true);
    assert.equal(error?.recovery?.cleanupRetained, true);
    assert.equal(error?.transaction, undefined);
    assert.equal(readlinkSync(join(root, 'rtk', 'current')), '0.44.0');
    assert.equal(readlinkSync(join(root, 'rtk', 'previous')), '0.43.0');
    assert.deepEqual(JSON.parse(readFileSync(transactionJournalPath(root, 'rtk'), 'utf8')), {
      schemaVersion: 1,
      name: 'rtk',
      snapshot: { current: '0.43.0', previous: '0.42.0' },
      desired: { current: '0.44.0', previous: '0.43.0' },
      phase: 'committed',
      cleanupState: 'pending',
      repairPrevious: false,
    });
    assert.deepEqual(readPointers(root, 'rtk', {
      durability: noOpDurability(),
    }), {
      current: '0.44.0',
      previous: '0.43.0',
    });
    assert.equal(existsSync(transactionJournalPath(root, 'rtk')), false);
  });

  it('refuses to delete a real staging directory', () => {
    const root = makeRoot();
    createVersion(root, 'rtk', '0.44.0');
    const stagingDirectory = join(root, 'rtk', 'current.new');
    mkdirSync(stagingDirectory);

    assert.throws(
      () => activateComponent({
        root,
        name: 'rtk',
        version: '0.44.0',
        platform: 'linux',
        durability: noOpDurability(),
      }),
      /refus|pointer artifact|link|junction/i,
    );
    assert.equal(lstatSync(stagingDirectory).isDirectory(), true);
  });

  it('fails closed without deleting a real active pointer directory', () => {
    const root = makeRoot();
    createVersion(root, 'rtk', '0.44.0');
    const activeDirectory = join(root, 'rtk', 'current');
    mkdirSync(activeDirectory);

    assert.throws(
      () => activateComponent({
        root,
        name: 'rtk',
        version: '0.44.0',
        platform: 'linux',
        durability: noOpDurability(),
      }),
      /non-link pointer artifact|pointer.*unsafe/i,
    );
    assert.equal(lstatSync(activeDirectory).isDirectory(), true);
  });

  it('uses one safely quoted cmd command string for junction paths with spaces and metacharacters', () => {
    const root = makeRoot();
    const commandRoot = join(root, 'component root & more');
    const target = createVersion(commandRoot, 'rtk', '0.44.0');
    const pointer = join(commandRoot, 'rtk', 'current.new');
    const commands = [];

    activateComponent({
      root: commandRoot,
      name: 'rtk',
      version: '0.44.0',
      platform: 'win32',
      runCommand(command, arguments_) {
        commands.push({ command, arguments: arguments_ });
        symlinkSync(target, pointer, 'dir');
      },
      durability: noOpDurability(),
    });

    assert.deepEqual(commands, [{
      command: 'cmd',
      arguments: [
        '/d',
        '/s',
        '/c',
        `mklink /J "${pointer}" "${target}"`,
      ],
    }]);
  });

  it('fails closed for Windows paths containing cmd variable-expansion metacharacters', () => {
    const root = makeRoot();
    const commandRoot = join(root, 'component root %EXPANSION%');
    const target = createVersion(commandRoot, 'rtk', '0.44.0');
    const pointer = join(commandRoot, 'rtk', 'current.new');

    assert.throws(
      () => activateComponent({
        root: commandRoot,
        name: 'rtk',
        version: '0.44.0',
        platform: 'win32',
        runCommand() {
          symlinkSync(target, pointer, 'dir');
        },
        durability: noOpDurability(),
      }),
      /cmd.*metacharacter|safe.*cmd/i,
    );
  });

  it('fails closed when a component lock is already held', () => {
    const root = makeRoot();
    createVersion(root, 'rtk', '0.44.0');

    assert.throws(
      () => readPointers(root, 'rtk', {
        lock: {
          acquire() {
            const error = new Error('simulated lock contention');
            error.code = 'EEXIST';
            throw error;
          },
          release() {},
        },
      }),
      /lock/i,
    );
  });

  it('reclaims a dead default lock before recovering a prepared transaction', () => {
    const root = makeRoot();
    createVersion(root, 'rtk', '0.43.0');
    createVersion(root, 'rtk', '0.44.0');
    writeTransactionJournal(root, 'rtk', {
      snapshot: { current: '0.43.0', previous: null },
      desired: { current: '0.44.0', previous: '0.43.0' },
      phase: 'prepared',
    });
    const lockDirectory = join(root, 'rtk', '.pointer-store.lock');
    mkdirSync(lockDirectory);
    writeFileSync(join(lockDirectory, 'owner.json'), JSON.stringify({
      pid: 2_147_483_647,
      token: 'dead-owner',
    }), 'utf8');

    assert.deepEqual(readPointers(root, 'rtk', {
      durability: noOpDurability(),
    }), {
      current: '0.43.0',
      previous: null,
    });
    assert.equal(existsSync(lockDirectory), false);
    assert.equal(existsSync(transactionJournalPath(root, 'rtk')), false);
  });

  it('does not reclaim a stale lock while another live process owns its reclaim claim', () => {
    const root = makeRoot();
    createVersion(root, 'rtk', '0.44.0');
    const lockDirectory = join(root, 'rtk', '.pointer-store.lock');
    mkdirSync(lockDirectory);
    writeFileSync(join(lockDirectory, 'owner.json'), JSON.stringify({
      pid: 2_147_483_647,
      token: 'dead-owner',
    }), 'utf8');
    writeFileSync(join(lockDirectory, '.reclaim'), JSON.stringify({
      pid: process.pid,
      token: 'live-reclaimer',
    }), 'utf8');

    assert.throws(
      () => readPointers(root, 'rtk', { durability: noOpDurability() }),
      /lock/i,
    );
    assert.equal(existsSync(lockDirectory), true);
  });

  it('publishes a default lock only after preparing its owner record in a temporary directory', () => {
    const root = makeRoot();
    createVersion(root, 'rtk', '0.44.0');
    const lockDirectory = join(root, 'rtk', '.pointer-store.lock');
    const events = [];
    const fs = testFs({
      mkdirSync(path, options) {
        events.push(`mkdir:${path}`);
        return mkdirSync(path, options);
      },
      renameSync(source, destination) {
        events.push(`rename:${source}:${destination}`);
        return renameSync(source, destination);
      },
    });

    activateComponent({
      root,
      name: 'rtk',
      version: '0.44.0',
      platform: 'linux',
      fs,
      durability: noOpDurability(),
    });

    assert.ok(events.some((event) => event.startsWith(`mkdir:${lockDirectory}.pending-`)));
    assert.ok(events.some((event) => (
      event.startsWith(`rename:${lockDirectory}.pending-`)
      && event.endsWith(`:${lockDirectory}`)
    )));
    assert.equal(existsSync(lockDirectory), false);
  });

  it('retries stale-lock reclaim when a concurrent reclaimer removes claim state', () => {
    const root = makeRoot();
    createVersion(root, 'rtk', '0.43.0');
    createVersion(root, 'rtk', '0.44.0');
    writeTransactionJournal(root, 'rtk', {
      snapshot: { current: '0.43.0', previous: null },
      desired: { current: '0.44.0', previous: '0.43.0' },
      phase: 'prepared',
    });
    const lockDirectory = join(root, 'rtk', '.pointer-store.lock');
    mkdirSync(lockDirectory);
    writeFileSync(join(lockDirectory, 'owner.json'), JSON.stringify({
      pid: 2_147_483_647,
      token: 'dead-owner',
    }), 'utf8');

    let interrupted = false;
    const fs = testFs({
      linkSync(source, destination) {
        if (!interrupted && destination === join(lockDirectory, '.reclaim')) {
          interrupted = true;
          const error = new Error('simulated concurrent reclaim');
          error.code = 'ENOENT';
          throw error;
        }
        return linkSync(source, destination);
      },
    });

    assert.deepEqual(readPointers(root, 'rtk', {
      fs,
      durability: noOpDurability(),
    }), {
      current: '0.43.0',
      previous: null,
    });
    assert.equal(interrupted, true);
  });

  it('reclaims a Windows stale lock when publication reports an existing-directory EPERM', () => {
    const root = makeRoot();
    createVersion(root, 'rtk', '0.43.0');
    createVersion(root, 'rtk', '0.44.0');
    writeTransactionJournal(root, 'rtk', {
      snapshot: { current: '0.43.0', previous: null },
      desired: { current: '0.44.0', previous: '0.43.0' },
      phase: 'prepared',
    });
    const lockDirectory = join(root, 'rtk', '.pointer-store.lock');
    mkdirSync(lockDirectory);
    writeFileSync(join(lockDirectory, 'owner.json'), JSON.stringify({
      pid: 2_147_483_647,
      token: 'dead-owner',
    }), 'utf8');

    const fs = testFs({
      renameSync(source, destination) {
        if (
          destination === lockDirectory
          && source.startsWith(`${lockDirectory}.pending-`)
          && existsSync(destination)
        ) {
          const error = new Error('Windows cannot overwrite an existing lock directory');
          error.code = 'EPERM';
          throw error;
        }
        return renameSync(source, destination);
      },
    });

    assert.deepEqual(readPointers(root, 'rtk', {
      fs,
      platform: 'win32',
      createJunction: (pointer, target) => symlinkSync(target, pointer, 'dir'),
      durability: noOpDurability(),
    }), {
      current: '0.43.0',
      previous: null,
    });
  });

  it('retries lock acquisition when an owner record disappears during a concurrent reclaim', () => {
    const root = makeRoot();
    createVersion(root, 'rtk', '0.43.0');
    createVersion(root, 'rtk', '0.44.0');
    writeTransactionJournal(root, 'rtk', {
      snapshot: { current: '0.43.0', previous: null },
      desired: { current: '0.44.0', previous: '0.43.0' },
      phase: 'prepared',
    });
    const lockDirectory = join(root, 'rtk', '.pointer-store.lock');
    const ownerPath = join(lockDirectory, 'owner.json');
    mkdirSync(lockDirectory);
    writeFileSync(ownerPath, JSON.stringify({
      pid: 2_147_483_647,
      token: 'dead-owner',
    }), 'utf8');

    let missingOwnerOnce = true;
    const fs = testFs({
      lstatSync(path) {
        if (path === ownerPath && missingOwnerOnce) {
          missingOwnerOnce = false;
          const error = new Error('simulated owner replacement');
          error.code = 'ENOENT';
          throw error;
        }
        return lstatSync(path);
      },
    });

    assert.deepEqual(readPointers(root, 'rtk', {
      fs,
      durability: noOpDurability(),
    }), {
      current: '0.43.0',
      previous: null,
    });
    assert.equal(missingOwnerOnce, false);
  });

  it('retries lock acquisition when a lock disappears during reclaim verification', () => {
    const root = makeRoot();
    createVersion(root, 'rtk', '0.43.0');
    createVersion(root, 'rtk', '0.44.0');
    writeTransactionJournal(root, 'rtk', {
      snapshot: { current: '0.43.0', previous: null },
      desired: { current: '0.44.0', previous: '0.43.0' },
      phase: 'prepared',
    });
    const lockDirectory = join(root, 'rtk', '.pointer-store.lock');
    const ownerPath = join(lockDirectory, 'owner.json');
    mkdirSync(lockDirectory);
    writeFileSync(ownerPath, JSON.stringify({
      pid: 2_147_483_647,
      token: 'dead-owner',
    }), 'utf8');

    let ownerReads = 0;
    const fs = testFs({
      readFileSync(path, encoding) {
        if (path === ownerPath) {
          ownerReads += 1;
          if (ownerReads === 2) {
            rmSync(lockDirectory, { recursive: true, force: false });
            const error = new Error('simulated released lock during reclaim');
            error.code = 'ENOENT';
            throw error;
          }
        }
        return readFileSync(path, encoding);
      },
    });

    assert.deepEqual(readPointers(root, 'rtk', {
      fs,
      durability: noOpDurability(),
    }), {
      current: '0.43.0',
      previous: null,
    });
    assert.equal(ownerReads, 3);
  });

  it('retries Windows lock acquisition when an EPERM collision disappears', () => {
    const root = makeRoot();
    createVersion(root, 'rtk', '0.43.0');
    createVersion(root, 'rtk', '0.44.0');
    writeTransactionJournal(root, 'rtk', {
      snapshot: { current: '0.43.0', previous: null },
      desired: { current: '0.44.0', previous: '0.43.0' },
      phase: 'prepared',
    });
    const lockDirectory = join(root, 'rtk', '.pointer-store.lock');
    mkdirSync(lockDirectory);
    writeFileSync(join(lockDirectory, 'owner.json'), JSON.stringify({
      pid: 2_147_483_647,
      token: 'dead-owner',
    }), 'utf8');

    let reportMissing = false;
    let epermOnce = true;
    const fs = testFs({
      lstatSync(path) {
        if (path === lockDirectory && reportMissing) {
          reportMissing = false;
          const error = new Error('simulated concurrently removed lock');
          error.code = 'ENOENT';
          throw error;
        }
        return lstatSync(path);
      },
      renameSync(source, destination) {
        if (
          epermOnce
          && destination === lockDirectory
          && source.startsWith(`${lockDirectory}.pending-`)
        ) {
          epermOnce = false;
          reportMissing = true;
          const error = new Error('simulated Windows collision');
          error.code = 'EPERM';
          throw error;
        }
        return renameSync(source, destination);
      },
    });

    assert.deepEqual(readPointers(root, 'rtk', {
      fs,
      platform: 'win32',
      createJunction: (pointer, target) => symlinkSync(target, pointer, 'dir'),
      durability: noOpDurability(),
    }), {
      current: '0.43.0',
      previous: null,
    });
    assert.equal(epermOnce, false);
  });

  it('requires a valid prior previous target for activation but permits explicit previous repair', () => {
    const root = makeRoot();
    createVersion(root, 'rtk', '0.42.0');
    createVersion(root, 'rtk', '0.43.0');
    createVersion(root, 'rtk', '0.44.0');
    activateComponent({
      root,
      name: 'rtk',
      version: '0.42.0',
      platform: 'linux',
      durability: noOpDurability(),
    });
    activateComponent({
      root,
      name: 'rtk',
      version: '0.43.0',
      platform: 'linux',
      durability: noOpDurability(),
    });
    rmSync(componentVersionDir(root, 'rtk', '0.42.0'), { recursive: true });

    assert.throws(
      () => activateComponent({
        root,
        name: 'rtk',
        version: '0.44.0',
        platform: 'linux',
        durability: noOpDurability(),
      }),
      /target version directory.*does not exist|previous/i,
    );
    assert.deepEqual(restoreComponent({
      root,
      name: 'rtk',
      pointers: { current: '0.43.0', previous: null },
      platform: 'linux',
      durability: noOpDurability(),
    }), {
      current: '0.43.0',
      previous: null,
    });
  });

  it('fsyncs a prepared journal and component directory before pointer mutation', () => {
    const root = makeRoot();
    createVersion(root, 'rtk', '0.44.0');
    const events = [];
    const fs = testFs({
      renameSync(source, destination) {
        events.push(`rename:${source}:${destination}`);
        return renameSync(source, destination);
      },
      writeFileSync(path, data, encoding) {
        events.push(`write:${path}`);
        return writeFileSync(path, data, encoding);
      },
    });
    const durability = {
      fsyncFile(path) {
        events.push(`fsync-file:${path}`);
      },
      fsyncDirectory(path) {
        events.push(`fsync-dir:${path}`);
      },
    };

    activateComponent({
      root,
      name: 'rtk',
      version: '0.44.0',
      platform: 'linux',
      fs,
      durability,
    });

    const preparedWrite = events.findIndex((event) => event.includes('.pointer-store-journal.json'));
    const firstPointerRename = events.findIndex((event) => event.includes('current.new'));
    assert.ok(preparedWrite >= 0);
    assert.ok(events.slice(preparedWrite + 1, firstPointerRename)
      .some((event) => event.includes('fsync-file:.') || event.includes('fsync-file:')));
    assert.ok(events.slice(preparedWrite + 1, firstPointerRename)
      .some((event) => event.startsWith(`fsync-dir:${join(root, 'rtk')}`)));
  });

  it('discards a truncated temporary journal when no committed journal exists', () => {
    const root = makeRoot();
    createVersion(root, 'rtk', '0.43.0');
    activateComponent({ root, name: 'rtk', version: '0.43.0', platform: 'linux' });
    // Simulate a crash mid-write-temporary: only the truncated .new file exists,
    // the committed journal was never created.
    writeFileSync(join(root, 'rtk', '.pointer-store-journal.json.new'), '{"schemaVersion":1,"na', 'utf8');

    assert.deepEqual(readPointers(root, 'rtk', { durability: noOpDurability() }), {
      current: '0.43.0',
      previous: null,
    });
    assert.equal(existsSync(join(root, 'rtk', '.pointer-store-journal.json.new')), false);
  });

  it('still fails closed on a malformed committed journal', () => {
    const root = makeRoot();
    createVersion(root, 'rtk', '0.43.0');
    activateComponent({ root, name: 'rtk', version: '0.43.0', platform: 'linux' });
    writeFileSync(transactionJournalPath(root, 'rtk'), '{"schemaVersion":1,"na', 'utf8');

    assert.throws(
      () => readPointers(root, 'rtk', { durability: noOpDurability() }),
      /malformed/i,
    );
    assert.equal(existsSync(transactionJournalPath(root, 'rtk')), true);
  });
});
