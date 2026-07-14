import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import {
  runtimePaths,
  releaseIdForCommit,
  readCurrentRelease,
  writeCurrentRelease,
} from '../src/runtime/release-store.mjs';
import { resolveRuntimeEntrypoint, writeManagedLauncher } from '../src/runtime/launcher.mjs';
import { stageMainRuntime } from '../src/runtime/stage-main.mjs';

function makeTempHome() {
  const home = join(process.cwd(), '.test-artifacts', `release-store-${process.pid}-${randomBytes(4).toString('hex')}`);
  mkdirSync(home, { recursive: true });
  return home;
}

describe('runtimePaths', () => {
  it('builds the managed runtime paths from home', () => {
    const home = '/home/alice';
    assert.deepEqual(runtimePaths('/home/alice'), {
      root: join(home, '.myelin'),
      releasesDir: join(home, '.myelin', 'releases'),
      currentPointerPath: join(home, '.myelin', 'current.json'),
      launcherPath: join(home, '.myelin', 'bin', 'myelin-launcher.mjs'),
    });
  });

  it('builds the managed runtime paths beneath a supplied root', () => {
    const home = '/home/alice';
    const rootDir = join(home, 'managed-root');
    assert.deepEqual(runtimePaths({ home, rootDir }), {
      root: rootDir,
      releasesDir: join(rootDir, 'releases'),
      currentPointerPath: join(rootDir, 'current.json'),
      launcherPath: join(rootDir, 'bin', 'myelin-launcher.mjs'),
    });
  });
});

describe('releaseIdForCommit', () => {
  it('prefixes commits with main-', () => {
    assert.equal(releaseIdForCommit('abcdef123456'), 'main-abcdef123456');
  });
});

describe('current release pointer', () => {
  it('returns null when current.json does not exist', () => {
    const home = makeTempHome();
    try {
      assert.equal(readCurrentRelease({ home }), null);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('writes and reads the current release atomically', () => {
    const home = makeTempHome();
    try {
      const result = writeCurrentRelease({ home, releaseId: 'main-abcdef1' });
      const runtimeRoot = join(home, '.myelin', 'releases', 'main-abcdef1');

      assert.deepEqual(result, {
        version: 1,
        releaseId: 'main-abcdef1',
        runtimeRoot,
      });
      assert.deepEqual(readCurrentRelease({ home }), result);
      assert.deepEqual(readdirSync(join(home, '.myelin')).filter((name) => name.endsWith('.tmp')), []);
      assert.equal(
        readFileSync(join(home, '.myelin', 'current.json'), 'utf8'),
        JSON.stringify(result, null, 2) + '\n'
      );
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('writes and reads a custom-root pointer beneath the supplied root', () => {
    const home = makeTempHome();
    const rootDir = join(home, 'managed-root');
    try {
      const result = writeCurrentRelease({ home, rootDir, releaseId: 'main-abcdef1' });
      const runtimeRoot = join(rootDir, 'releases', 'main-abcdef1');

      assert.deepEqual(result, {
        version: 1,
        releaseId: 'main-abcdef1',
        runtimeRoot,
      });
      assert.deepEqual(readCurrentRelease({ home, rootDir }), result);
      assert.equal(readCurrentRelease({ home, rootDir }).runtimeRoot, runtimeRoot);
      assert.equal(
        readFileSync(join(rootDir, 'current.json'), 'utf8'),
        JSON.stringify(result, null, 2) + '\n'
      );
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('keeps an explicit Windows managed root separator-safe', () => {
    const rootDir = 'D:\\managed\\myelin';
    const files = new Map();
    const pointerPath = `${rootDir}\\current.json`;
    const result = writeCurrentRelease({
      home: '/home/alice',
      rootDir,
      releaseId: 'main-abcdef1',
      mkdirSyncFn() {},
      writeFileSyncFn(path, content) {
        files.set(path, content);
      },
      readFileSyncFn(path) {
        const content = files.get(path);
        if (content == null) throw new Error(`missing file: ${path}`);
        return content;
      },
      renameSyncFn(from, to) {
        files.set(to, files.get(from));
        files.delete(from);
      },
    });

    assert.deepEqual(result, {
      version: 1,
      releaseId: 'main-abcdef1',
      runtimeRoot: 'D:\\managed\\myelin\\releases\\main-abcdef1',
    });
    assert.equal(files.has(pointerPath), true);
  });

  it('removes an invalid temporary pointer before promotion', () => {
    const home = makeTempHome();
    try {
      assert.throws(() => writeCurrentRelease({
        home,
        releaseId: 'main-abcdef1',
        writeFileSyncFn(tempPath) {
          writeFileSync(tempPath, Buffer.from([0xff, 0x00, 0x61]));
        },
      }), /invalid current release pointer/i);
      assert.equal(readCurrentRelease({ home }), null);
      assert.deepEqual(readdirSync(join(home, '.myelin')).filter((name) => name.endsWith('.tmp')), []);
      assert.equal(
        readdirSync(join(home, '.myelin')).includes('current.json'),
        false
      );
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('rejects malformed release ids', () => {
    const home = makeTempHome();
    try {
      assert.throws(() => writeCurrentRelease({ home, releaseId: 'main-xyz' }), /invalid release id/i);
      assert.throws(() => writeCurrentRelease({ home, releaseId: 'release-abcdef1' }), /invalid release id/i);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('fsyncs the temp pointer (open→write→fsync→close) before renaming it into place', () => {
    const events = [];
    const files = new Map();
    const fdToPath = new Map();
    let nextFd = 10;

    const result = writeCurrentRelease({
      home: '/home/alice',
      releaseId: 'main-abcdef1',
      mkdirSyncFn() {},
      openSyncFn(path, flags) {
        const fd = nextFd++;
        fdToPath.set(fd, path);
        events.push(`open:${path}:${flags}`);
        return fd;
      },
      writeSyncFn(fd, content) {
        files.set(fdToPath.get(fd), content);
        events.push(`write:${fdToPath.get(fd)}`);
      },
      fsyncSyncFn(fd) {
        events.push(`fsync:${fdToPath.get(fd)}`);
      },
      closeSyncFn(fd) {
        events.push(`close:${fdToPath.get(fd)}`);
      },
      readFileSyncFn(path) {
        const content = files.get(path);
        if (content == null) throw new Error(`missing file: ${path}`);
        return content;
      },
      renameSyncFn(from, to) {
        files.set(to, files.get(from));
        files.delete(from);
        events.push(`rename:${from}->${to}`);
      },
    });

    assert.deepEqual(result, {
      version: 1,
      releaseId: 'main-abcdef1',
      runtimeRoot: join('/home/alice', '.myelin', 'releases', 'main-abcdef1'),
    });

    const openIdx = events.findIndex((e) => e.startsWith('open:'));
    const writeIdx = events.findIndex((e) => e.startsWith('write:'));
    const fsyncIdx = events.findIndex((e) => e.startsWith('fsync:'));
    const closeIdx = events.findIndex((e) => e.startsWith('close:'));
    const renameIdx = events.findIndex((e) => e.startsWith('rename:'));

    assert.ok(openIdx >= 0, `expected an open: ${events.join(', ')}`);
    assert.ok(writeIdx > openIdx, `write after open: ${events.join(', ')}`);
    assert.ok(fsyncIdx > writeIdx, `fsync after write: ${events.join(', ')}`);
    assert.ok(closeIdx > fsyncIdx, `close after fsync: ${events.join(', ')}`);
    assert.ok(renameIdx > closeIdx, `rename only after fsync+close: ${events.join(', ')}`);
    // The write must target the temp pointer, not the live pointer, and the
    // fsync'd fd must be the temp file's fd.
    assert.ok(events[openIdx].includes('.tmp'), `open targets temp file: ${events.join(', ')}`);
    assert.ok(events[fsyncIdx].includes('.tmp'), `fsync targets temp file: ${events.join(', ')}`);
  });

  it('still promotes the pointer when fsync is unsupported (fail-safe)', () => {
    const home = makeTempHome();
    try {
      const result = writeCurrentRelease({
        home,
        releaseId: 'main-abcdef1',
        fsyncSyncFn() { throw new Error('EINVAL: fsync not supported'); },
      });

      assert.deepEqual(readCurrentRelease({ home }), result);
      assert.deepEqual(readdirSync(join(home, '.myelin')).filter((name) => name.endsWith('.tmp')), []);
      assert.equal(
        readFileSync(join(home, '.myelin', 'current.json'), 'utf8'),
        JSON.stringify(result, null, 2) + '\n',
      );
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('returns null for invalid pointer contents', () => {
    const home = makeTempHome();
    try {
      mkdirSync(join(home, '.myelin'), { recursive: true });
      writeFileSync(join(home, '.myelin', 'current.json'), '{"version":2}', 'utf8');

      assert.equal(readCurrentRelease({ home }), null);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('resolves the managed runtime entrypoint from the current pointer', () => {
    const home = makeTempHome();
    try {
      writeCurrentRelease({ home, releaseId: 'main-abcdef1' });
      assert.equal(
        resolveRuntimeEntrypoint({ home }),
        join(home, '.myelin', 'releases', 'main-abcdef1', 'src', 'cli', 'index.mjs'),
      );
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('keeps a Windows managed runtime entrypoint separator-safe', () => {
    assert.equal(
      resolveRuntimeEntrypoint({
        readCurrentReleaseFn: () => ({
          runtimeRoot: 'D:\\managed\\myelin\\releases\\main-abcdef1',
        }),
      }),
      'D:\\managed\\myelin\\releases\\main-abcdef1\\src\\cli\\index.mjs',
    );
  });

  it('writes launcher files that stay on current.json instead of a checkout', () => {
    const home = makeTempHome();
    try {
      const result = writeManagedLauncher({ home, os: 'darwin' });
      const launcherSource = readFileSync(result.launcherPath, 'utf8');
      const commandSource = readFileSync(result.commandPath, 'utf8');
      const repoEntrypoint = join(process.cwd(), 'src', 'cli', 'index.mjs');

      assert.ok(launcherSource.includes('current.json'));
      assert.ok(commandSource.includes('myelin-launcher.mjs'));
      assert.ok(!launcherSource.includes('/.myelin/repo'));
      assert.ok(!launcherSource.includes(repoEntrypoint));
      assert.ok(!commandSource.includes(repoEntrypoint));
      assert.ok(launcherSource.includes('process.env.MYELIN_DIR'));
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('generated launcher source guards a blank MYELIN_DIR with trim()', () => {
    const home = makeTempHome();
    try {
      const result = writeManagedLauncher({ home, os: 'darwin' });
      const launcherSource = readFileSync(result.launcherPath, 'utf8');
      assert.ok(launcherSource.includes('.trim()'));
      assert.ok(!launcherSource.includes('process.env.MYELIN_DIR || join'));
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('generated launcher accepts equivalent WSL-mounted and Windows runtime roots', () => {
    const home = makeTempHome();
    try {
      const result = writeManagedLauncher({ home, os: 'darwin' });
      const launcherSource = readFileSync(result.launcherPath, 'utf8');
      assert.ok(launcherSource.includes('normalizedRuntimeRoot'));
      assert.ok(launcherSource.includes('normalizedRuntimeRoot(parsed.runtimeRoot)'));
      assert.ok(launcherSource.includes('isWindowsDriveRoot'));
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('generated launcher treats a blank/whitespace MYELIN_DIR as absent and falls back to home', () => {
    const home = makeTempHome();
    try {
      const result = writeManagedLauncher({ home, os: 'darwin' });
      const releaseId = 'main-abcdef1234567';
      const entrypoint = join(home, '.myelin', 'releases', releaseId, 'src', 'cli', 'index.mjs');
      mkdirSync(dirname(entrypoint), { recursive: true });
      writeFileSync(entrypoint, "console.log('LAUNCH-HOME');\n", 'utf8');
      writeCurrentRelease({ home, releaseId });

      const r = spawnSync(process.execPath, [result.launcherPath], {
        env: { ...process.env, HOME: home, USERPROFILE: home, MYELIN_DIR: '   ' },
        encoding: 'utf8',
      });
      assert.equal(r.status, 0, `stderr: ${r.stderr}`);
      assert.equal(r.stdout, 'LAUNCH-HOME\n');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('writes the launcher beneath a supplied root', () => {
    const home = makeTempHome();
    const rootDir = join(home, 'managed-root');
    try {
      const result = writeManagedLauncher({ home, rootDir, os: 'darwin' });
      assert.equal(result.launcherPath, join(rootDir, 'bin', 'myelin-launcher.mjs'));
      assert.equal(result.commandPath, join(rootDir, 'bin', 'myelin'));
      assert.ok(existsSync(result.launcherPath));
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('keeps Windows managed launcher paths separator-safe', () => {
    const rootDir = 'D:\\managed\\myelin';
    const directories = [];
    const written = [];
    const result = writeManagedLauncher({
      home: '/home/alice',
      rootDir,
      os: 'windows',
      mkdirSyncFn(path) {
        directories.push(path);
      },
      writeFileSyncFn(path) {
        written.push(path);
      },
      chmodSyncFn() {},
    });

    assert.deepEqual(result, {
      binDir: 'D:\\managed\\myelin\\bin',
      launcherPath: 'D:\\managed\\myelin\\bin\\myelin-launcher.mjs',
      commandPath: 'D:\\managed\\myelin\\bin\\myelin.cmd',
    });
    assert.deepEqual(directories, ['D:\\managed\\myelin\\bin']);
    assert.deepEqual(written, [
      'D:\\managed\\myelin\\bin\\myelin-launcher.mjs',
      'D:\\managed\\myelin\\bin\\myelin.cmd',
    ]);
  });
});

describe('stageMainRuntime', () => {
  const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const nodeCommand = process.platform === 'win32' ? 'node.exe' : 'node';

  it('stages main, validates it, renames it, then activates the managed runtime', () => {
    const home = makeTempHome();
    const events = [];
    const repoUrl = 'https://github.com/yehsuf/myelin';
    const stagedAt = 1700000000000;

    try {
      const result = stageMainRuntime({
        home,
        repoUrl,
        execFileSyncFn(command, args, options = {}) {
          if (command === 'git' && args[0] === 'clone') {
            events.push('clone');
            assert.deepEqual(args, ['clone', '--depth', '1', '--branch', 'main', repoUrl, join(home, '.myelin', `releases-stage-main-${process.pid}-${stagedAt}`)]);
            assert.equal(existsSync(args[6]), true);
            mkdirSync(join(args[6], 'src', 'cli'), { recursive: true });
            writeFileSync(join(args[6], 'src', 'cli', 'index.mjs'), 'export const ok = true;\n', 'utf8');
            return Buffer.alloc(0);
          }

          if (command === 'git' && args[0] === 'rev-parse') {
            events.push('rev-parse');
            assert.equal(options.cwd, join(home, '.myelin', `releases-stage-main-${process.pid}-${stagedAt}`));
            return 'abcdef123456\n';
          }

          if (command === npmCommand) {
            events.push('npm-ci');
            assert.deepEqual(args, ['ci', '--ignore-scripts']);
            assert.equal(options.cwd, join(home, '.myelin', `releases-stage-main-${process.pid}-${stagedAt}`));
            mkdirSync(join(options.cwd, 'node_modules'), { recursive: true });
            return Buffer.alloc(0);
          }

          if (command === nodeCommand) {
            events.push('node-check');
            assert.deepEqual(args, ['--check', 'src/cli/index.mjs']);
            assert.equal(options.cwd, join(home, '.myelin', `releases-stage-main-${process.pid}-${stagedAt}`));
            assert.equal(existsSync(join(options.cwd, 'node_modules')), true);
            return Buffer.alloc(0);
          }

          throw new Error(`unexpected command: ${command} ${args.join(' ')}`);
        },
        existsSyncFn: existsSync,
        rmSyncFn: rmSync,
        mkdirSyncFn(path, options) {
          if (path.endsWith(`releases-stage-main-${process.pid}-${stagedAt}`)) {
            events.push('mkdir-temp');
          }
          mkdirSync(path, options);
        },
        renameSyncFn(from, to) {
          events.push('rename');
          renameSync(from, to);
        },
        writeCurrentReleaseFn(options) {
          events.push('activate');
          return writeCurrentRelease(options);
        },
        nowFn: () => stagedAt,
      });

      const runtimeRoot = join(home, '.myelin', 'releases', 'main-abcdef123456');
      assert.deepEqual(events, ['mkdir-temp', 'clone', 'rev-parse', 'npm-ci', 'node-check', 'rename', 'activate']);
      assert.deepEqual(result, {
        releaseId: 'main-abcdef123456',
        runtimeRoot,
        reused: false,
      });
      assert.deepEqual(readCurrentRelease({ home }), {
        version: 1,
        releaseId: 'main-abcdef123456',
        runtimeRoot,
      });
      assert.equal(existsSync(join(home, '.myelin', `releases-stage-main-${process.pid}-${stagedAt}`)), false);
      assert.equal(existsSync(join(runtimeRoot, 'src', 'cli', 'index.mjs')), true);
      assert.equal(existsSync(join(runtimeRoot, 'node_modules')), true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('removes a failed staged candidate and leaves the old pointer unchanged', () => {
    const home = makeTempHome();
    const repoUrl = 'https://github.com/yehsuf/myelin';
    const stagedAt = 1700000000001;
    const oldReleaseId = 'main-deadbeef1234';
    const oldRuntimeRoot = join(home, '.myelin', 'releases', oldReleaseId);

    try {
      mkdirSync(join(oldRuntimeRoot, 'src', 'cli'), { recursive: true });
      mkdirSync(join(oldRuntimeRoot, 'node_modules'), { recursive: true });
      writeFileSync(join(oldRuntimeRoot, 'src', 'cli', 'index.mjs'), 'export const old = true;\n', 'utf8');
      writeCurrentRelease({ home, releaseId: oldReleaseId });

      assert.throws(() => stageMainRuntime({
        home,
        repoUrl,
        execFileSyncFn(command, args, options = {}) {
          if (command === 'git' && args[0] === 'clone') {
            mkdirSync(join(args[6], 'src', 'cli'), { recursive: true });
            writeFileSync(join(args[6], 'src', 'cli', 'index.mjs'), 'export const staged = true;\n', 'utf8');
            return Buffer.alloc(0);
          }

          if (command === 'git' && args[0] === 'rev-parse') {
            assert.equal(options.cwd, join(home, '.myelin', `releases-stage-main-${process.pid}-${stagedAt}`));
            return 'feedfacecafe\n';
          }

          if (command === npmCommand) {
            throw new Error('npm ci failed');
          }

          throw new Error(`unexpected command: ${command} ${args.join(' ')}`);
        },
        existsSyncFn: existsSync,
        rmSyncFn: rmSync,
        mkdirSyncFn: mkdirSync,
        nowFn: () => stagedAt,
      }), /npm ci failed/);

      assert.deepEqual(readCurrentRelease({ home }), {
        version: 1,
        releaseId: oldReleaseId,
        runtimeRoot: oldRuntimeRoot,
      });
      assert.equal(existsSync(join(home, '.myelin', `releases-stage-main-${process.pid}-${stagedAt}`)), false);
      assert.equal(existsSync(join(oldRuntimeRoot, 'src', 'cli', 'index.mjs')), true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('reuses an existing complete managed release for the same main commit', () => {
    const home = makeTempHome();
    const repoUrl = 'https://github.com/yehsuf/myelin';
    const releaseId = 'main-abcdef123456';
    const runtimeRoot = join(home, '.myelin', 'releases', releaseId);
    const stagedAt = 1700000000002;
    const commands = [];

    try {
      mkdirSync(join(runtimeRoot, 'src', 'cli'), { recursive: true });
      mkdirSync(join(runtimeRoot, 'node_modules'), { recursive: true });
      writeFileSync(join(runtimeRoot, 'src', 'cli', 'index.mjs'), 'export const existing = true;\n', 'utf8');

      const result = stageMainRuntime({
        home,
        repoUrl,
        execFileSyncFn(command, args) {
          commands.push(`${command} ${args.join(' ')}`);
          if (command === 'git' && args[0] === 'clone') {
            mkdirSync(join(args[6], 'src', 'cli'), { recursive: true });
            writeFileSync(join(args[6], 'src', 'cli', 'index.mjs'), 'export const staged = true;\n', 'utf8');
            return Buffer.alloc(0);
          }

          if (command === 'git' && args[0] === 'rev-parse') {
            return 'abcdef123456\n';
          }

          throw new Error(`unexpected command: ${command} ${args.join(' ')}`);
        },
        existsSyncFn: existsSync,
        rmSyncFn: rmSync,
        mkdirSyncFn: mkdirSync,
        nowFn: () => stagedAt,
      });

      assert.deepEqual(commands, [
        `git clone --depth 1 --branch main ${repoUrl} ${join(home, '.myelin', `releases-stage-main-${process.pid}-${stagedAt}`)}`,
        'git rev-parse --short=12 HEAD',
      ]);
      assert.deepEqual(result, { releaseId, runtimeRoot, reused: true });
      assert.deepEqual(readCurrentRelease({ home }), {
        version: 1,
        releaseId,
        runtimeRoot,
      });
      assert.equal(existsSync(join(home, '.myelin', `releases-stage-main-${process.pid}-${stagedAt}`)), false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('removes an incomplete existing release and restages it before activation', () => {
    const home = makeTempHome();
    const repoUrl = 'https://github.com/yehsuf/myelin';
    const releaseId = 'main-abcdef123456';
    const runtimeRoot = join(home, '.myelin', 'releases', releaseId);
    const stagedAt = 1700000000003;
    const events = [];

    try {
      mkdirSync(join(runtimeRoot, 'src', 'cli'), { recursive: true });
      writeFileSync(join(runtimeRoot, 'src', 'cli', 'index.mjs'), 'export const stale = true;\n', 'utf8');

      const result = stageMainRuntime({
        home,
        repoUrl,
        execFileSyncFn(command, args, options = {}) {
          if (command === 'git' && args[0] === 'clone') {
            events.push('clone');
            mkdirSync(join(args[6], 'src', 'cli'), { recursive: true });
            writeFileSync(join(args[6], 'src', 'cli', 'index.mjs'), 'export const staged = true;\n', 'utf8');
            return Buffer.alloc(0);
          }

          if (command === 'git' && args[0] === 'rev-parse') {
            events.push('rev-parse');
            assert.equal(options.cwd, join(home, '.myelin', `releases-stage-main-${process.pid}-${stagedAt}`));
            return 'abcdef123456\n';
          }

          if (command === npmCommand) {
            events.push('npm-ci');
            mkdirSync(join(options.cwd, 'node_modules'), { recursive: true });
            return Buffer.alloc(0);
          }

          if (command === nodeCommand) {
            events.push('node-check');
            return Buffer.alloc(0);
          }

          throw new Error(`unexpected command: ${command} ${args.join(' ')}`);
        },
        existsSyncFn: existsSync,
        rmSyncFn(path, options) {
          if (path === runtimeRoot) {
            events.push('rm-incomplete');
          }
          rmSync(path, options);
        },
        mkdirSyncFn: mkdirSync,
        renameSyncFn(from, to) {
          events.push('rename');
          renameSync(from, to);
        },
        writeCurrentReleaseFn(options) {
          events.push('activate');
          return writeCurrentRelease(options);
        },
        nowFn: () => stagedAt,
      });

      // The incomplete destination is only removed AFTER the candidate is
      // validated (npm-ci + node-check), so a failed restage can never destroy
      // an existing release before a working replacement is proven.
      assert.deepEqual(events, ['clone', 'rev-parse', 'npm-ci', 'node-check', 'rm-incomplete', 'rename', 'activate']);
      assert.deepEqual(result, { releaseId, runtimeRoot, reused: false });
      assert.equal(existsSync(join(runtimeRoot, 'node_modules')), true);
      assert.deepEqual(readCurrentRelease({ home }), {
        version: 1,
        releaseId,
        runtimeRoot,
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('preserves the active runtime and pointer when a same-commit restage fails', () => {
    const home = makeTempHome();
    const repoUrl = 'https://github.com/yehsuf/myelin';
    const releaseId = 'main-abcdef123456';
    const runtimeRoot = join(home, '.myelin', 'releases', releaseId);
    const stagedAt = 1700000000010;

    try {
      // The active release exists but is INCOMPLETE (no node_modules) and the
      // pointer already targets it. A restage of the SAME commit must not delete
      // it until a validated replacement exists.
      mkdirSync(join(runtimeRoot, 'src', 'cli'), { recursive: true });
      writeFileSync(join(runtimeRoot, 'src', 'cli', 'index.mjs'), 'export const active = true;\n', 'utf8');
      writeCurrentRelease({ home, releaseId });

      assert.throws(() => stageMainRuntime({
        home,
        repoUrl,
        execFileSyncFn(command, args, options = {}) {
          if (command === 'git' && args[0] === 'clone') {
            mkdirSync(join(args[6], 'src', 'cli'), { recursive: true });
            writeFileSync(join(args[6], 'src', 'cli', 'index.mjs'), 'export const staged = true;\n', 'utf8');
            return Buffer.alloc(0);
          }
          if (command === 'git' && args[0] === 'rev-parse') {
            return 'abcdef123456\n';
          }
          if (command === npmCommand) {
            throw new Error('npm ci failed');
          }
          throw new Error(`unexpected command: ${command} ${args.join(' ')}`);
        },
        existsSyncFn: existsSync,
        rmSyncFn: rmSync,
        mkdirSyncFn: mkdirSync,
        nowFn: () => stagedAt,
      }), /npm ci failed/);

      // Old (incomplete) release directory and its pointer are untouched.
      assert.equal(existsSync(runtimeRoot), true);
      assert.equal(existsSync(join(runtimeRoot, 'src', 'cli', 'index.mjs')), true);
      assert.deepEqual(readCurrentRelease({ home }), {
        version: 1,
        releaseId,
        runtimeRoot,
      });
      assert.equal(existsSync(join(home, '.myelin', `releases-stage-main-${process.pid}-${stagedAt}`)), false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('retains a validated candidate without writing the pointer when activate is false', () => {
    const home = makeTempHome();
    const repoUrl = 'https://github.com/yehsuf/myelin';
    const releaseId = 'main-abcdef123456';
    const runtimeRoot = join(home, '.myelin', 'releases', releaseId);
    const stagedAt = 1700000000011;
    const events = [];

    try {
      const result = stageMainRuntime({
        home,
        repoUrl,
        activate: false,
        execFileSyncFn(command, args, options = {}) {
          if (command === 'git' && args[0] === 'clone') {
            events.push('clone');
            mkdirSync(join(args[6], 'src', 'cli'), { recursive: true });
            writeFileSync(join(args[6], 'src', 'cli', 'index.mjs'), 'export const staged = true;\n', 'utf8');
            return Buffer.alloc(0);
          }
          if (command === 'git' && args[0] === 'rev-parse') {
            events.push('rev-parse');
            return 'abcdef123456\n';
          }
          if (command === npmCommand) {
            events.push('npm-ci');
            mkdirSync(join(options.cwd, 'node_modules'), { recursive: true });
            return Buffer.alloc(0);
          }
          if (command === nodeCommand) {
            events.push('node-check');
            return Buffer.alloc(0);
          }
          throw new Error(`unexpected command: ${command} ${args.join(' ')}`);
        },
        existsSyncFn: existsSync,
        rmSyncFn: rmSync,
        mkdirSyncFn: mkdirSync,
        renameSyncFn(from, to) {
          events.push('rename');
          renameSync(from, to);
        },
        writeCurrentReleaseFn(options) {
          events.push('activate');
          return writeCurrentRelease(options);
        },
        nowFn: () => stagedAt,
      });

      // Candidate validated and renamed into place, but never activated.
      assert.deepEqual(events, ['clone', 'rev-parse', 'npm-ci', 'node-check', 'rename']);
      assert.deepEqual(result, { releaseId, runtimeRoot, reused: false });
      assert.equal(existsSync(join(runtimeRoot, 'src', 'cli', 'index.mjs')), true);
      assert.equal(existsSync(join(runtimeRoot, 'node_modules')), true);
      // No pointer written — the active runtime is unchanged.
      assert.equal(readCurrentRelease({ home }), null);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('reuses an existing release without activating when activate is false', () => {
    const home = makeTempHome();
    const repoUrl = 'https://github.com/yehsuf/myelin';
    const releaseId = 'main-abcdef123456';
    const runtimeRoot = join(home, '.myelin', 'releases', releaseId);
    const stagedAt = 1700000000012;
    const writeCalls = [];

    try {
      mkdirSync(join(runtimeRoot, 'src', 'cli'), { recursive: true });
      mkdirSync(join(runtimeRoot, 'node_modules'), { recursive: true });
      writeFileSync(join(runtimeRoot, 'src', 'cli', 'index.mjs'), 'export const existing = true;\n', 'utf8');

      const result = stageMainRuntime({
        home,
        repoUrl,
        activate: false,
        execFileSyncFn(command, args) {
          if (command === 'git' && args[0] === 'clone') {
            mkdirSync(join(args[6], 'src', 'cli'), { recursive: true });
            writeFileSync(join(args[6], 'src', 'cli', 'index.mjs'), 'export const staged = true;\n', 'utf8');
            return Buffer.alloc(0);
          }
          if (command === 'git' && args[0] === 'rev-parse') {
            return 'abcdef123456\n';
          }
          throw new Error(`unexpected command: ${command} ${args.join(' ')}`);
        },
        existsSyncFn: existsSync,
        rmSyncFn: rmSync,
        mkdirSyncFn: mkdirSync,
        writeCurrentReleaseFn(options) {
          writeCalls.push(options);
          return writeCurrentRelease(options);
        },
        nowFn: () => stagedAt,
      });

      assert.deepEqual(result, { releaseId, runtimeRoot, reused: true });
      assert.equal(writeCalls.length, 0);
      assert.equal(readCurrentRelease({ home }), null);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('forwards an explicit rootDir to runtimePaths and writeCurrentRelease', () => {
    const home = makeTempHome();
    const rootDir = join(home, 'managed-root');
    const repoUrl = 'https://github.com/yehsuf/myelin';
    const releaseId = 'main-abcdef123456';
    const runtimeRoot = join(rootDir, 'releases', releaseId);
    const stagedAt = 1700000000004;
    const writeCalls = [];

    try {
      // Pre-stage a complete release under the custom root so the reuse path runs.
      mkdirSync(join(runtimeRoot, 'src', 'cli'), { recursive: true });
      mkdirSync(join(runtimeRoot, 'node_modules'), { recursive: true });
      writeFileSync(join(runtimeRoot, 'src', 'cli', 'index.mjs'), 'export const ok = true;\n', 'utf8');

      const result = stageMainRuntime({
        home,
        rootDir,
        repoUrl,
        execFileSyncFn(command, args, options = {}) {
          if (command === 'git' && args[0] === 'clone') {
            // Clone target must live beneath the custom root, not <home>/.myelin.
            assert.equal(args[6], join(rootDir, `releases-stage-main-${process.pid}-${stagedAt}`));
            mkdirSync(join(args[6], 'src', 'cli'), { recursive: true });
            writeFileSync(join(args[6], 'src', 'cli', 'index.mjs'), 'export const staged = true;\n', 'utf8');
            return Buffer.alloc(0);
          }
          if (command === 'git' && args[0] === 'rev-parse') {
            assert.equal(options.cwd, join(rootDir, `releases-stage-main-${process.pid}-${stagedAt}`));
            return 'abcdef123456\n';
          }
          throw new Error(`unexpected command: ${command} ${args.join(' ')}`);
        },
        existsSyncFn: existsSync,
        rmSyncFn: rmSync,
        mkdirSyncFn: mkdirSync,
        writeCurrentReleaseFn(options) {
          writeCalls.push(options);
          return writeCurrentRelease(options);
        },
        nowFn: () => stagedAt,
      });

      assert.deepEqual(result, { releaseId, runtimeRoot, reused: true });
      assert.equal(writeCalls.length, 1);
      assert.equal(writeCalls[0].rootDir, rootDir);
      assert.equal(writeCalls[0].releaseId, releaseId);
      // Pointer + runtime resolve beneath the custom root, not <home>/.myelin.
      assert.deepEqual(readCurrentRelease({ home, rootDir }), {
        version: 1,
        releaseId,
        runtimeRoot,
      });
      assert.equal(existsSync(join(home, '.myelin', 'current.json')), false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('keeps Windows managed release paths separator-safe while staging', () => {
    const rootDir = 'D:\\managed\\myelin';
    const stagedAt = 1700000000005;
    const releaseId = 'main-abcdef123456';
    const stageRoot = `D:\\managed\\myelin\\releases-stage-main-${process.pid}-${stagedAt}`;
    const runtimeRoot = `D:\\managed\\myelin\\releases\\${releaseId}`;
    const calls = [];

    const result = stageMainRuntime({
      home: '/home/alice',
      rootDir,
      repoUrl: 'https://github.com/yehsuf/myelin',
      execFileSyncFn(command, args, options = {}) {
        calls.push({ command, args, options });
        if (command === 'git' && args[0] === 'clone') return Buffer.alloc(0);
        if (command === 'git' && args[0] === 'rev-parse') return 'abcdef123456\n';
        return Buffer.alloc(0);
      },
      existsSyncFn: () => false,
      mkdirSyncFn() {},
      renameSyncFn(from, to) {
        calls.push({ command: 'rename', args: [from, to] });
      },
      writeCurrentReleaseFn(options) {
        calls.push({ command: 'activate', args: [options] });
      },
      nowFn: () => stagedAt,
    });

    assert.deepEqual(result, { releaseId, runtimeRoot, reused: false });
    assert.equal(calls[0].args[6], stageRoot);
    assert.equal(calls[1].options.cwd, stageRoot);
    assert.deepEqual(calls.find(({ command }) => command === 'rename').args, [stageRoot, runtimeRoot]);
  });
});

describe('bootstrap scripts', () => {
  it('stages and runs the managed runtime installer from install.sh', () => {
    const script = readFileSync(join(process.cwd(), 'install.sh'), 'utf8');

    assert.ok(script.includes('git clone --depth 1 --branch main'));
    assert.ok(script.includes('npm ci --ignore-scripts'));
    assert.ok(script.includes('node --check src/cli/index.mjs'));
    assert.ok(script.includes('current.json'));
    assert.ok(script.includes('releases-stage-main-'));
    assert.ok(script.includes('Running staged installer'));
    assert.ok(script.includes('node "$RUNTIME_ROOT/src/install.mjs" "$@"'));
    assert.ok(!script.includes('pull --ff-only'));
    assert.ok(!script.includes('/repo'));
  });

  it('exports MYELIN_DIR and skips activation for --dry-run/--check in install.sh', () => {
    const script = readFileSync(join(process.cwd(), 'install.sh'), 'utf8');

    // The selected managed root is exported so the staged installer and its
    // generated runtime consumers resolve the same relocated MYELIN_DIR.
    assert.ok(script.includes('export MYELIN_DIR'));
    // Non-activating modes are detected before staging.
    assert.ok(/--dry-run/.test(script));
    assert.ok(/--check/.test(script));
    // The current-release pointer is only written when activating.
    assert.ok(/ACTIVATE/.test(script));
    assert.ok(/if \[ "\$ACTIVATE" = "1" \]/.test(script));
  });

  it('stages and runs the managed runtime installer from install.ps1', () => {
    const script = readFileSync(join(process.cwd(), 'install.ps1'), 'utf8');

    assert.ok(script.includes('git clone --depth 1 --branch main'));
    assert.ok(script.includes('npm ci --ignore-scripts'));
    assert.ok(script.includes('node --check src/cli/index.mjs'));
    assert.ok(script.includes('current.json'));
    assert.ok(script.includes('releases-stage-main-'));
    assert.ok(script.includes('Running staged installer'));
    assert.ok(script.includes('node @a'));
    assert.ok(!script.includes('pull --ff-only'));
    assert.ok(!script.includes('\\repo'));
  });

  it('exports MYELIN_DIR, skips activation for -DryRun/-Check, and uses MyelinDir bin in install.ps1', () => {
    const script = readFileSync(join(process.cwd(), 'install.ps1'), 'utf8');

    // Managed root is exported into the process environment for the staged run.
    assert.ok(script.includes('$env:MYELIN_DIR = $MyelinDir'));
    // The Windows Defender bin exclusion follows the relocated managed root.
    assert.ok(script.includes("Join-Path $MyelinDir 'bin'"));
    assert.ok(!script.includes('$env:USERPROFILE\\.myelin\\bin'));
    // Non-activating modes bypass the pointer writer.
    assert.ok(script.includes('$DryRun -or $Check'));
    assert.ok(/\$Activate/.test(script));
  });
});
