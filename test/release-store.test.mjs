import { afterEach, describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { dirname, join, posix } from 'node:path';
import { gzipSync } from 'node:zlib';
import {
  runtimePaths,
  releaseIdForCommit,
  readCurrentRelease,
  writeCurrentRelease,
} from '../src/runtime/release-store.mjs';
import { resolveRuntimeEntrypoint, writeManagedLauncher } from '../src/runtime/launcher.mjs';
import { stageMainRuntime } from '../src/runtime/stage-main.mjs';
import { resolveMyelinRoot } from '../src/shared/myelin-paths.mjs';
import {
  activateRelease,
  installStableLauncher,
  readReleasePointers,
  restoreRelease,
  stageRelease,
} from '../src/update/release-store.mjs';

// A POSIX `sh` is absent on Windows hosts (spawnSync sh -> ENOENT). Guard any
// behavioral shell test so full coverage runs on POSIX while staying green on
// a real Windows host.
function hasPosixSh() {
  if (process.platform === 'win32') return false;
  try {
    const r = spawnSync('sh', ['-c', 'exit 0']);
    return !r.error && r.status === 0;
  } catch {
    return false;
  }
}

// PowerShell (pwsh) may be absent. Guard the behavioral install.ps1 canonicalizer
// test so it runs where pwsh exists and is skipped (source assertions still run)
// otherwise.
function hasPwsh() {
  try {
    const r = spawnSync('pwsh', ['-NoProfile', '-Command', 'exit 0']);
    return !r.error && r.status === 0;
  } catch {
    return false;
  }
}

function makeTempHome() {
  const home = join(process.cwd(), '.test-artifacts', `release-store-${process.pid}-${randomBytes(4).toString('hex')}`);
  mkdirSync(home, { recursive: true });
  return home;
}

describe('runtimePaths', { concurrency: false }, () => {
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

describe('releaseIdForCommit', { concurrency: false }, () => {
  it('prefixes commits with main-', () => {
    assert.equal(releaseIdForCommit('abcdef123456'), 'main-abcdef123456');
  });
});

describe('current release pointer', { concurrency: false }, () => {
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

  // The generated launcher must canonicalize an explicit MYELIN_DIR exactly like
  // the installer's resolveMyelinRoot: a ~-prefixed or relative root resolves
  // against $HOME, not verbatim/cwd — so installer and generated launcher never
  // target different managed roots.
  for (const label of ['tilde', 'relative', 'absolute']) {
    it(`generated launcher resolves a ${label} MYELIN_DIR to the resolveMyelinRoot root`, () => {
      const home = makeTempHome();
      try {
        const result = writeManagedLauncher({ home, os: 'darwin' });
        const releaseId = 'main-abcdef1234567';
        const myelinDir = label === 'tilde' ? '~/launcher-canon'
          : label === 'relative' ? 'relative-launcher-canon'
          : join(home, 'absolute-launcher-canon');
        const resolvedRoot = resolveMyelinRoot({ home, env: { MYELIN_DIR: myelinDir } });
        if (label !== 'absolute') assert.notEqual(resolvedRoot, myelinDir);

        const entrypoint = join(resolvedRoot, 'releases', releaseId, 'src', 'cli', 'index.mjs');
        mkdirSync(dirname(entrypoint), { recursive: true });
        writeFileSync(entrypoint, "console.log('LAUNCH-CANON');\n", 'utf8');
        writeCurrentRelease({ home, rootDir: resolvedRoot, releaseId });

        const r = spawnSync(process.execPath, [result.launcherPath], {
          env: { ...process.env, HOME: home, USERPROFILE: home, MYELIN_DIR: myelinDir },
          encoding: 'utf8',
        });
        assert.equal(r.status, 0, `stderr: ${r.stderr}`);
        assert.equal(r.stdout, 'LAUNCH-CANON\n');
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    });
  }

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

describe('stageMainRuntime', { concurrency: false }, () => {
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

describe('bootstrap scripts', { concurrency: false }, () => {
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

  // M3: the current.json pointer embeds RUNTIME_ROOT/RELEASE_ID as JSON string
  // values. A managed root containing a `"` or `\` must be escaped, or the file
  // is corrupt (invalid JSON that readCurrentRelease then fails to parse).
  it('escapes RUNTIME_ROOT/RELEASE_ID into valid JSON in install.sh', { skip: !hasPosixSh() }, () => {
    const script = readFileSync(join(process.cwd(), 'install.sh'), 'utf8');

    // The pointer writer must route BOTH interpolated values through the escaper
    // rather than splicing the raw variables straight into the JSON heredoc.
    const fnMatch = /^json_escape\(\) \{[\s\S]*?^\}/m.exec(script);
    assert.ok(fnMatch, 'install.sh must define a json_escape helper');
    assert.ok(/json_escape "\$RELEASE_ID"/.test(script), 'RELEASE_ID must be escaped');
    assert.ok(/json_escape "\$RUNTIME_ROOT"/.test(script), 'RUNTIME_ROOT must be escaped');

    // Behavioral (bats-free) check: run the actual shell helper on a path with a
    // quote AND a backslash and confirm the emitted JSON string round-trips.
    const runEscape = (value) => {
      const harness = `${fnMatch[0]}\njson_escape "$1"\n`;
      const res = spawnSync('sh', ['-s', value], { input: harness, encoding: 'utf8' });
      assert.equal(res.status, 0, res.stderr);
      return res.stdout.replace(/\n$/, ''); // mirror $(...) trailing-newline stripping
    };

    for (const nasty of ['/opt/a"b\\c/myelin', '/srv/quote"only', 'C:\\back\\slash\\only', 'main-"$(id)"']) {
      const escaped = runEscape(nasty);
      const json = `{\n  "version": 1,\n  "runtimeRoot": "${escaped}"\n}\n`;
      const parsed = JSON.parse(json); // throws if escaping is wrong
      assert.equal(parsed.runtimeRoot, nasty, `round-trip failed for ${nasty}`);
    }
  });

  // fix-review #3: install.sh must canonicalize an explicit MYELIN_DIR exactly
  // like Node's resolveMyelinRoot (expand ~ / ~/ against $HOME, root a relative
  // value at $HOME, pass an absolute value through) BEFORE staging/pointer
  // writing — otherwise the shell installer and the Node runtime target
  // different roots.
  it('canonicalizes ~ / ~/ / relative MYELIN_DIR against $HOME like resolveMyelinRoot', { skip: !hasPosixSh() }, () => {
    const script = readFileSync(join(process.cwd(), 'install.sh'), 'utf8');

    const fnMatch = /^canonicalize_myelin_dir\(\) \{[\s\S]*?^\}/m.exec(script);
    assert.ok(fnMatch, 'install.sh must define a canonicalize_myelin_dir helper');
    // The default and explicit values both flow through the canonicalizer.
    assert.ok(
      /MYELIN_DIR="\$\(canonicalize_myelin_dir "\$\{MYELIN_DIR:-\$HOME\/\.myelin\}"\)"/.test(script),
      'MYELIN_DIR must be assigned from canonicalize_myelin_dir',
    );

    const canon = (value, home) => {
      const harness = `HOME='${home}'\n${fnMatch[0]}\ncanonicalize_myelin_dir "$1"\n`;
      const res = spawnSync('sh', ['-s', value], { input: harness, encoding: 'utf8' });
      assert.equal(res.status, 0, res.stderr);
      return res.stdout.replace(/\n$/, '');
    };

    const HOME = '/home/tester';
    // Bare tilde -> $HOME.
    assert.equal(canon('~', HOME), HOME);
    // ~/ -> $HOME/rest.
    assert.equal(canon('~/managed', HOME), '/home/tester/managed');
    assert.equal(canon('~/deep/nested', HOME), '/home/tester/deep/nested');
    // Relative -> rooted at $HOME (never cwd).
    assert.equal(canon('managed', HOME), '/home/tester/managed');
    assert.equal(canon('a/b', HOME), '/home/tester/a/b');
    // Absolute -> passthrough.
    assert.equal(canon('/opt/myelin', HOME), '/opt/myelin');
    // Default resolves to $HOME/.myelin (already absolute -> passthrough).
    assert.equal(canon('/home/tester/.myelin', HOME), '/home/tester/.myelin');
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

  it('defines Canonicalize-MyelinDir and applies it to $MyelinDir before staging in install.ps1', () => {
    const script = readFileSync(join(process.cwd(), 'install.ps1'), 'utf8');

    // The canonicalizer exists (parity with install.sh canonicalize_myelin_dir).
    assert.ok(/function\s+Canonicalize-MyelinDir\b/.test(script));
    // $MyelinDir is normalized through it.
    assert.ok(/\$MyelinDir\s*=\s*Canonicalize-MyelinDir\s+\$MyelinDir/.test(script));

    // Normalization must happen BEFORE any staging (New-Item / git clone / pointer
    // write) and before it is exported so installer + generated runtime agree.
    const canonIdx = script.indexOf('$MyelinDir = Canonicalize-MyelinDir $MyelinDir');
    assert.ok(canonIdx >= 0);
    const exportIdx = script.indexOf('$env:MYELIN_DIR = $MyelinDir');
    assert.ok(exportIdx >= 0);
    assert.ok(canonIdx < exportIdx, 'canonicalization must precede MYELIN_DIR export');
    const newItemIdx = script.indexOf('New-Item');
    if (newItemIdx >= 0) {
      assert.ok(canonIdx < newItemIdx, 'canonicalization must precede first New-Item');
    }
    const cloneIdx = script.search(/git\s+clone/);
    if (cloneIdx >= 0) {
      assert.ok(canonIdx < cloneIdx, 'canonicalization must precede git clone');
    }
  });

  it('Canonicalize-MyelinDir mirrors resolveMyelinRoot: ~ / ~/ / relative / absolute', { skip: !hasPwsh() }, () => {
    const script = readFileSync(join(process.cwd(), 'install.ps1'), 'utf8');
    // Extract the function body (closing brace is at column 0).
    const m = script.match(/^function Canonicalize-MyelinDir \{[\s\S]*?^\}/m);
    assert.ok(m, 'Canonicalize-MyelinDir function block should be extractable');
    const fn = m[0];

    // Use a POSIX base so pwsh Join-Path works cross-platform (pwsh on non-Windows
    // rejects fabricated drive letters like C:). This validates the branching logic;
    // real Windows drive joins are exercised on Windows hosts.
    const base = '/home/canon-tester';
    const harness = [
      `$env:USERPROFILE = '${base}'`,
      fn,
      '$r = [ordered]@{',
      "  tilde = Canonicalize-MyelinDir '~'",
      "  tildeSlash = Canonicalize-MyelinDir '~/managed'",
      "  tildeBack = Canonicalize-MyelinDir '~\\managed'",
      "  tildeEmpty = Canonicalize-MyelinDir '~/'",
      "  relative = Canonicalize-MyelinDir 'managed'",
      "  reldeep = Canonicalize-MyelinDir 'a/b'",
      "  drive = Canonicalize-MyelinDir 'D:\\managed\\myelin'",
      "  unc = Canonicalize-MyelinDir '\\\\server\\share\\m'",
      `  abspass = Canonicalize-MyelinDir '${base}/.myelin'`,
      '}',
      '$r | ConvertTo-Json -Compress',
    ].join('\n');

    const r = spawnSync('pwsh', ['-NoProfile', '-Command', harness], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr || 'pwsh harness failed');
    const out = JSON.parse(r.stdout);

    assert.equal(out.tilde, base);
    assert.equal(out.tildeSlash, `${base}/managed`);
    assert.equal(out.tildeBack, `${base}/managed`);
    assert.equal(out.tildeEmpty, base);
    assert.equal(out.relative, `${base}/managed`);
    assert.equal(out.reldeep, `${base}/a/b`);
    // Absolute inputs pass through untouched.
    assert.equal(out.drive, 'D:\\managed\\myelin');
    assert.equal(out.unc, '\\\\server\\share\\m');
    assert.equal(out.abspass, `${base}/.myelin`);
  });

  it('guards a blank/whitespace MYELIN_DIR with IsNullOrWhiteSpace BEFORE canonicalization (source)', () => {
    const script = readFileSync(join(process.cwd(), 'install.ps1'), 'utf8');

    // A null/empty/whitespace-only MYELIN_DIR is treated as absent (parity with
    // Node's resolveMyelinRoot `value.trim() ? value : undefined`).
    assert.ok(
      /\[string\]::IsNullOrWhiteSpace\(\$env:MYELIN_DIR\)/.test(script),
      'MYELIN_DIR must be guarded with [string]::IsNullOrWhiteSpace',
    );
    // The whitespace fallback must run BEFORE Canonicalize-MyelinDir — otherwise
    // a whitespace value would be rooted at USERPROFILE as `<USERPROFILE>\   `.
    const guardIdx = script.search(/\$MyelinDir\s*=\s*if\s*\(\[string\]::IsNullOrWhiteSpace\(\$env:MYELIN_DIR\)\)/);
    const canonIdx = script.indexOf('$MyelinDir = Canonicalize-MyelinDir $MyelinDir');
    assert.ok(guardIdx >= 0, 'whitespace guard assignment must exist');
    assert.ok(canonIdx >= 0, 'canonicalization must exist');
    assert.ok(guardIdx < canonIdx, 'whitespace fallback must precede canonicalization');
  });

  it('install.ps1 resolves a blank/whitespace MYELIN_DIR to the SAME root as unset (behavioral)', { skip: !hasPwsh() }, () => {
    const script = readFileSync(join(process.cwd(), 'install.ps1'), 'utf8');
    const fnMatch = script.match(/^function Canonicalize-MyelinDir \{[\s\S]*?^\}/m);
    assert.ok(fnMatch, 'Canonicalize-MyelinDir function block should be extractable');
    // Extract the REAL two-line resolution logic from install.ps1 (guard + canon).
    const resolveMatch = script.match(
      /\$MyelinDir = if \(\[string\]::IsNullOrWhiteSpace\(\$env:MYELIN_DIR\)\)[\s\S]*?\$MyelinDir = Canonicalize-MyelinDir \$MyelinDir/,
    );
    assert.ok(resolveMatch, 'MYELIN_DIR resolution (guard + canonicalization) should be extractable');

    const base = '/home/canon-tester';
    const run = (setup) => {
      const harness = [
        `$env:USERPROFILE = '${base}'`,
        setup,
        fnMatch[0],
        resolveMatch[0],
        '$MyelinDir',
      ].join('\n');
      const r = spawnSync('pwsh', ['-NoProfile', '-Command', harness], { encoding: 'utf8' });
      assert.equal(r.status, 0, r.stderr || 'pwsh harness failed');
      return r.stdout.trim();
    };

    const unset = run('Remove-Item Env:MYELIN_DIR -ErrorAction SilentlyContinue');
    assert.ok(unset.length > 0);
    assert.ok(unset.endsWith('.myelin'), `unset MYELIN_DIR should default to <home>/.myelin: ${unset}`);

    // Blank / whitespace-only / tab-only / empty all resolve to the SAME default
    // root as unset — never `<USERPROFILE>\   ` — mirroring resolveMyelinRoot.
    assert.equal(run("$env:MYELIN_DIR = '   '"), unset, 'whitespace MYELIN_DIR must equal the unset default');
    assert.equal(run('$env:MYELIN_DIR = "`t`t"'), unset, 'tab-only MYELIN_DIR must equal the unset default');
    assert.equal(run("$env:MYELIN_DIR = ''"), unset, 'empty MYELIN_DIR must equal the unset default');
  });
});

const temporaryRoots = [];

function makeRoot() {
  const root = mkdtempSync(join(process.cwd(), '.test-release-store-'));
  temporaryRoots.push(root);
  return root;
}

function writeReleaseSource(root, version = '1.1.0') {
  mkdirSync(join(root, 'bin'), { recursive: true });
  mkdirSync(join(root, 'src', 'update'), { recursive: true });
  mkdirSync(join(root, 'test'), { recursive: true });
  writeFileSync(join(root, 'package.json'), JSON.stringify({
    name: 'myelin',
    version,
    bin: { myelin: './bin/myelin' },
  }));
  writeFileSync(join(root, 'package-lock.json'), JSON.stringify({
    name: 'myelin',
    version,
    lockfileVersion: 3,
  }));
  writeFileSync(join(root, 'bin', 'myelin'), '#!/usr/bin/env node\n');
  writeFileSync(join(root, 'src', 'update', 'component-manifest.mjs'), 'export {};\n');
  writeFileSync(join(root, 'test', 'component-manifest.test.mjs'), 'export {};\n');
}

function createRelease(releasesRoot, version) {
  const release = join(releasesRoot, version);
  mkdirSync(release, { recursive: true });
  return release;
}

function tarGzipEntries(entries) {
  const blocks = entries.flatMap(({ name, content = '', type = '0' }) => {
    const header = Buffer.alloc(512);
    header.write(name, 0, Math.min(Buffer.byteLength(name), 100), 'utf8');
    header.write('0000644\0', 100, 8, 'ascii');
    header.write('0000000\0', 108, 8, 'ascii');
    header.write('0000000\0', 116, 8, 'ascii');
    header.write(`${Buffer.byteLength(content).toString(8).padStart(11, '0')}\0`, 124, 12, 'ascii');
    header[156] = type.charCodeAt(0);
    const data = Buffer.from(content);
    const padding = Buffer.alloc((512 - (data.length % 512)) % 512);
    return [header, data, padding];
  });
  return gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)]));
}

function tarGzip(name, content = '') {
  return tarGzipEntries([{ name, content }]);
}

function paxRecord(key, value) {
  const payload = `${key}=${value}\n`;
  let length = Buffer.byteLength(payload) + 2;
  while (Buffer.byteLength(`${length} ${payload}`) !== length) {
    length = Buffer.byteLength(`${length} ${payload}`);
  }
  return `${length} ${payload}`;
}

function fullFs(overrides = {}) {
  return {
    existsSync,
    lstatSync,
    mkdirSync,
    readFileSync,
    readlinkSync,
    renameSync,
    rmSync,
    statSync,
    symlinkSync,
    writeFileSync,
    ...overrides,
  };
}

function makeFakePosixFs(dirs = []) {
  const store = new Map(dirs.map(d => [d, { type: 'dir' }]));
  const makeStat = (entry) => ({
    isDirectory: () => entry.type === 'dir',
    isSymbolicLink: () => entry.type === 'symlink',
    isFile: () => entry.type === 'file',
  });
  const fs = {
    lstatSync(path) {
      const entry = store.get(path);
      if (!entry) { const err = new Error(`ENOENT: no such file or directory, lstat '${path}'`); err.code = 'ENOENT'; throw err; }
      return makeStat(entry);
    },
    readlinkSync(path) {
      const entry = store.get(path);
      if (!entry) { const err = new Error(`ENOENT: no such file or directory, readlink '${path}'`); err.code = 'ENOENT'; throw err; }
      if (entry.type !== 'symlink') { const err = new Error(`EINVAL: invalid argument, readlink '${path}'`); err.code = 'EINVAL'; throw err; }
      return entry.target;
    },
    symlinkSync(target, dest) { store.set(dest, { type: 'symlink', target }); },
    rmSync(path) { store.delete(path); },
    renameSync(from, to) {
      const entry = store.get(from);
      if (!entry) { const err = new Error(`ENOENT: no such file or directory, rename '${from}'`); err.code = 'ENOENT'; throw err; }
      store.set(to, entry);
      store.delete(from);
    },
    mkdirSync() {},
  };
  return { fs, store };
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('managed release store', { concurrency: false }, () => {
  it('stages a validated release without changing the active pointer', async () => {
    const root = makeRoot();
    const managedHome = join(root, '.myelin');
    const releasesRoot = join(managedHome, 'releases');
    const source = join(root, 'source');
    writeReleaseSource(source);
    createRelease(releasesRoot, '1.0.0');
    symlinkSync(join('releases', '1.0.0'), join(managedHome, 'current'), 'dir');
    const commands = [];

    const result = await stageRelease({
      target: {
        channel: 'stable',
        version: '1.1.0',
        source: { type: 'directory', path: source },
      },
      releasesRoot,
      exec: (file, args, options) => {
        commands.push({ file, args, options });
        return '';
      },
    });

    assert.equal(result.version, '1.1.0');
    assert.equal(result.directory, join(releasesRoot, '1.1.0'));
    assert.equal(readlinkSync(join(managedHome, 'current')), join('releases', '1.0.0'));
    assert.equal(existsSync(join(releasesRoot, '1.1.0', 'package.json')), true);
    assert.deepEqual(commands.map(({ file, args }) => [file, args]), [
      process.platform === 'win32'
        ? ['cmd.exe', ['/d', '/s', '/c', 'npm "ci" "--ignore-scripts=false"']]
        : ['npm', ['ci', '--ignore-scripts=false']],
      ['node', ['bin/myelin', '--version']],
      ['node', ['--test', 'test/component-manifest.test.mjs']],
    ]);
    assert.ok(commands.every(({ options }) => options.cwd.endsWith(join('releases', '.1.1.0.staging'))));
  });

  it('cleans failed staging and leaves the active pointer unchanged', async () => {
    const root = makeRoot();
    const managedHome = join(root, '.myelin');
    const releasesRoot = join(managedHome, 'releases');
    const source = join(root, 'source');
    writeReleaseSource(source);
    createRelease(releasesRoot, '1.0.0');
    symlinkSync(join('releases', '1.0.0'), join(managedHome, 'current'), 'dir');

    await assert.rejects(
      () => stageRelease({
        target: {
          channel: 'stable',
          version: '1.1.0',
          source: { type: 'directory', path: source },
        },
        releasesRoot,
        exec: () => {
          throw new Error('npm ci failed');
        },
      }),
      /npm ci failed/,
    );

    assert.equal(existsSync(join(releasesRoot, '1.1.0')), false);
    assert.equal(readlinkSync(join(managedHome, 'current')), join('releases', '1.0.0'));
  });

  it('rejects traversal release IDs and tar archive traversal before activation', async () => {
    const root = makeRoot();
    const managedHome = join(root, '.myelin');
    const releasesRoot = join(managedHome, 'releases');
    createRelease(releasesRoot, '1.0.0');
    symlinkSync(join('releases', '1.0.0'), join(managedHome, 'current'), 'dir');

    await assert.rejects(
      () => stageRelease({
        target: {
          channel: 'stable',
          version: '../outside',
          source: { type: 'directory', path: root },
        },
        releasesRoot,
        exec: () => {},
      }),
      /release version/i,
    );

    await assert.rejects(
      () => stageRelease({
        target: {
          channel: 'stable',
          version: '1.1.0',
          source: { type: 'tarball', url: 'https://example.test/release.tar.gz' },
        },
        releasesRoot,
        fetch: async () => ({
          ok: true,
          arrayBuffer: async () => tarGzip('../outside', 'unsafe'),
        }),
        exec: () => {},
      }),
      /unsafe archive path/i,
    );

    assert.equal(readlinkSync(join(managedHome, 'current')), join('releases', '1.0.0'));
    assert.equal(existsSync(join(releasesRoot, '1.1.0')), false);
  });

  it('rejects a tar root file that shadows the extracted release directory', async () => {
    const root = makeRoot();
    const releasesRoot = join(root, '.myelin', 'releases');
    const packageJson = JSON.stringify({
      name: 'myelin',
      version: '1.1.0',
      bin: { myelin: './bin/myelin' },
    });

    await assert.rejects(
      () => stageRelease({
        target: {
          channel: 'stable',
          version: '1.1.0',
          source: { type: 'tarball', url: 'https://example.test/release.tar.gz' },
        },
        releasesRoot,
        fetch: async () => ({
          ok: true,
          arrayBuffer: async () => tarGzipEntries([
            { name: 'release', content: 'shadow' },
            { name: 'release/package.json', content: packageJson },
            { name: 'release/package-lock.json', content: '{}' },
            { name: 'release/bin/myelin', content: '#!/usr/bin/env node\n' },
            { name: 'release/src/update/component-manifest.mjs', content: 'export {};\n' },
            { name: 'release/test/component-manifest.test.mjs', content: 'export {};\n' },
          ]),
        }),
        exec: () => {},
      }),
      /archive.*shadow|unsafe archive/i,
    );
  });

  it('stages a standard PAX-prefixed Git source archive', async () => {
    const root = makeRoot();
    const releasesRoot = join(root, '.myelin', 'releases');
    const packageJson = JSON.stringify({
      name: 'myelin',
      version: '1.1.0',
      bin: { myelin: './bin/myelin' },
    });

    await stageRelease({
      target: {
        channel: 'stable',
        version: '1.1.0',
        source: { type: 'tarball', url: 'https://example.test/release.tar.gz' },
      },
      releasesRoot,
      fetch: async () => ({
        ok: true,
        arrayBuffer: async () => tarGzipEntries([
          { name: 'pax_global_header', type: 'g', content: paxRecord('comment', 'release-source') },
          { name: 'release/package.json', content: packageJson },
          { name: 'release/package-lock.json', content: '{}' },
          { name: 'release/bin/myelin', content: '#!/usr/bin/env node\n' },
          { name: 'release/src/update/component-manifest.mjs', content: 'export {};\n' },
          { name: 'release/test/component-manifest.test.mjs', content: 'export {};\n' },
        ]),
      }),
      exec: () => {},
    });

    assert.equal(existsSync(join(releasesRoot, '1.1.0', 'package.json')), true);
  });

  it('uses a PAX path override while preserving extraction confinement', async () => {
    const root = makeRoot();
    const releasesRoot = join(root, '.myelin', 'releases');
    const packageJson = JSON.stringify({
      name: 'myelin',
      version: '1.1.0',
      bin: { myelin: './bin/myelin' },
    });

    await stageRelease({
      target: {
        channel: 'stable',
        version: '1.1.0',
        source: { type: 'tarball', url: 'https://example.test/release.tar.gz' },
      },
      releasesRoot,
      fetch: async () => ({
        ok: true,
        arrayBuffer: async () => tarGzipEntries([
          { name: 'PaxHeaders/package', type: 'x', content: paxRecord('path', 'release/package.json') },
          { name: 'placeholder', content: packageJson },
          { name: 'release/package-lock.json', content: '{}' },
          { name: 'release/bin/myelin', content: '#!/usr/bin/env node\n' },
          { name: 'release/src/update/component-manifest.mjs', content: 'export {};\n' },
          { name: 'release/test/component-manifest.test.mjs', content: 'export {};\n' },
        ]),
      }),
      exec: () => {},
    });

    assert.equal(existsSync(join(releasesRoot, '1.1.0', 'package.json')), true);
  });

  it('rejects a traversal PAX path override', async () => {
    const root = makeRoot();

    await assert.rejects(
      () => stageRelease({
        target: {
          channel: 'stable',
          version: '1.1.0',
          source: { type: 'tarball', url: 'https://example.test/release.tar.gz' },
        },
        releasesRoot: join(root, '.myelin', 'releases'),
        fetch: async () => ({
          ok: true,
          arrayBuffer: async () => tarGzipEntries([
            { name: 'PaxHeaders/package', type: 'x', content: paxRecord('path', '../outside') },
            { name: 'placeholder', content: 'unsafe' },
          ]),
        }),
        exec: () => {},
      }),
      /unsafe archive path/i,
    );
  });

  it('rejects an oversized declared tarball before buffering its body', async () => {
    const root = makeRoot();
    let bodyRead = false;

    await assert.rejects(
      () => stageRelease({
        target: {
          channel: 'stable',
          version: '1.1.0',
          source: { type: 'tarball', url: 'https://example.test/release.tar.gz' },
        },
        releasesRoot: join(root, '.myelin', 'releases'),
        fetch: async () => ({
          ok: true,
          headers: {
            get: (name) => (
              name.toLowerCase() === 'content-length'
                ? String(512 * 1024 * 1024 + 1)
                : null
            ),
          },
          arrayBuffer: async () => {
            bodyRead = true;
            return new ArrayBuffer(0);
          },
        }),
        exec: () => {},
      }),
      /maximum safe size/i,
    );

    assert.equal(bodyRead, false);
  });

  it('preserves current and previous release pointers and restores them after a failed switch', { skip: process.platform === 'win32' }, () => {
    const root = makeRoot();
    const managedHome = join(root, '.myelin');
    const releasesRoot = join(managedHome, 'releases');
    createRelease(releasesRoot, '1.0.0');
    createRelease(releasesRoot, '1.1.0');

    assert.deepEqual(
      activateRelease({ releasesRoot, version: '1.0.0', platform: 'linux' }),
      { current: '1.0.0', previous: null },
    );
    assert.deepEqual(
      activateRelease({ releasesRoot, version: '1.1.0', platform: 'linux' }),
      { current: '1.1.0', previous: '1.0.0' },
    );
    assert.equal(readlinkSync(join(managedHome, 'current')), join('releases', '1.1.0'));
    assert.equal(readlinkSync(join(managedHome, 'previous')), join('releases', '1.0.0'));

    let failed = false;
    const fs = fullFs({
      renameSync(from, to) {
        if (!failed && from.endsWith('previous.new') && to.endsWith('previous')) {
          failed = true;
          throw new Error('pointer install failed');
        }
        return renameSync(from, to);
      },
    });

    assert.throws(
      () => activateRelease({
        releasesRoot,
        version: '1.0.0',
        platform: 'linux',
        fs,
      }),
      /pointer install failed/,
    );
    assert.equal(readlinkSync(join(managedHome, 'current')), join('releases', '1.1.0'));
    assert.equal(readlinkSync(join(managedHome, 'previous')), join('releases', '1.0.0'));
  });

  it('restores an exact current and previous release pair', { skip: process.platform === 'win32' }, () => {
    const root = makeRoot();
    const managedHome = join(root, '.myelin');
    const releasesRoot = join(managedHome, 'releases');
    createRelease(releasesRoot, '0.9.0');
    createRelease(releasesRoot, '1.0.0');
    createRelease(releasesRoot, '1.1.0');

    activateRelease({ releasesRoot, version: '0.9.0', platform: 'linux' });
    activateRelease({ releasesRoot, version: '1.0.0', platform: 'linux' });
    activateRelease({ releasesRoot, version: '1.1.0', platform: 'linux' });

    assert.deepEqual(
      restoreRelease({
        releasesRoot,
        pointers: { current: '1.0.0', previous: '0.9.0' },
        platform: 'linux',
      }),
      { current: '1.0.0', previous: '0.9.0' },
    );
    assert.deepEqual(
      readReleasePointers({ releasesRoot, platform: 'linux' }),
      { current: '1.0.0', previous: '0.9.0' },
    );
  });

  it('recovers interrupted release-pair artifacts before restoring a snapshot', { skip: process.platform === 'win32' }, () => {
    const root = makeRoot();
    const managedHome = join(root, '.myelin');
    const releasesRoot = join(managedHome, 'releases');
    createRelease(releasesRoot, '1.0.0');
    createRelease(releasesRoot, '1.1.0');
    activateRelease({ releasesRoot, version: '1.0.0', platform: 'linux' });

    renameSync(
      join(managedHome, 'current'),
      join(managedHome, 'current.old'),
    );
    symlinkSync(
      join('releases', '1.1.0'),
      join(managedHome, 'current.new'),
      'dir',
    );

    restoreRelease({
      releasesRoot,
      pointers: { current: '1.0.0', previous: null },
      platform: 'linux',
    });

    assert.deepEqual(
      readReleasePointers({ releasesRoot, platform: 'linux' }),
      { current: '1.0.0', previous: null },
    );
    assert.equal(existsSync(join(managedHome, 'current.old')), false);
    assert.equal(existsSync(join(managedHome, 'current.new')), false);
  });

  it('atomically replaces the POSIX current pointer instead of parking it first', { skip: process.platform === 'win32' }, () => {
    const root = makeRoot();
    const managedHome = join(root, '.myelin');
    const releasesRoot = join(managedHome, 'releases');
    createRelease(releasesRoot, '1.0.0');
    createRelease(releasesRoot, '1.1.0');
    activateRelease({ releasesRoot, version: '1.0.0', platform: 'linux' });
    const renames = [];
    const fs = fullFs({
      renameSync(from, to) {
        renames.push([from, to]);
        return renameSync(from, to);
      },
    });

    activateRelease({ releasesRoot, version: '1.1.0', platform: 'linux', fs });

    assert.equal(
      renames.some(([from, to]) => from.endsWith('/current') && to.endsWith('/current.old')),
      false,
    );
    assert.equal(readlinkSync(join(managedHome, 'current')), join('releases', '1.1.0'));
  });

  it('uses an injected Windows junction creator instead of symlink privileges', () => {
    const releasesRoot = '/fake-test/.myelin/releases';
    const managedHome = '/fake-test/.myelin';
    const { fs, store } = makeFakePosixFs(['/fake-test/.myelin/releases/1.0.0']);
    const junctions = [];

    const result = activateRelease({
      releasesRoot,
      version: '1.0.0',
      platform: 'win32',
      pathImpl: posix,
      fs,
      createJunction(pointer, target) {
        junctions.push({ pointer, target });
        store.set(pointer, { type: 'symlink', target });
      },
    });

    assert.deepEqual(result, { current: '1.0.0', previous: null });
    assert.deepEqual(junctions, [{
      pointer: posix.join(managedHome, 'current.new'),
      target: posix.join(releasesRoot, '1.0.0'),
    }]);
  });

  it('uses verbatim argv handling for the default Windows junction command', () => {
    const releasesRoot = '/fake-test/.myelin/releases';
    const managedHome = '/fake-test/.myelin';
    const { fs, store } = makeFakePosixFs(['/fake-test/.myelin/releases/1.0.0']);
    const commands = [];

    activateRelease({
      releasesRoot,
      version: '1.0.0',
      platform: 'win32',
      pathImpl: posix,
      fs,
      runCommand(file, args, options) {
        commands.push({ file, args, options });
        store.set(posix.join(managedHome, 'current.new'), {
          type: 'symlink',
          target: posix.join(releasesRoot, '1.0.0'),
        });
      },
    });

    assert.equal(commands.length, 1);
    assert.equal(commands[0].file, 'cmd.exe');
    assert.equal(commands[0].options.windowsVerbatimArguments, true);
  });

  it('removes a temporary junction if junction creation reports a switch failure', () => {
    const releasesRoot = '/fake-test/.myelin/releases';
    const managedHome = '/fake-test/.myelin';
    const { fs, store } = makeFakePosixFs(['/fake-test/.myelin/releases/1.0.0']);

    assert.throws(
      () => activateRelease({
        releasesRoot,
        version: '1.0.0',
        platform: 'win32',
        pathImpl: posix,
        fs,
        createJunction(pointer, target) {
          store.set(pointer, { type: 'symlink', target });
          throw new Error('junction creation reported failure');
        },
      }),
      /junction creation reported failure/,
    );
    assert.equal(store.has(posix.join(managedHome, 'current.new')), false);
  });

  it('writes launchers that resolve the current release at invocation time', () => {
    const root = makeRoot();
    const posixResult = installStableLauncher({ home: root, platform: 'linux' });
    const posixLauncher = readFileSync(posixResult.launcher, 'utf8');

    assert.match(posixLauncher, /current\/bin\/myelin/);
    assert.match(posixLauncher, /exec node "\$entry" "\$@"/);

    const windowsHome = join(root, 'home & still-safe');
    const windowsResult = installStableLauncher({
      home: windowsHome,
      platform: 'win32',
      pathImpl: posix,
    });
    const commandLauncher = readFileSync(windowsResult.commandLauncher, 'utf8');
    const powerShellLauncher = readFileSync(windowsResult.powerShellLauncher, 'utf8');

    assert.match(commandLauncher, /%~dp0/);
    assert.match(commandLauncher, /current\\bin\\myelin/);
    assert.doesNotMatch(commandLauncher, /home & still-safe/);
    assert.match(powerShellLauncher, /-LiteralPath/);
    assert.match(powerShellLauncher, /@args/);
    assert.doesNotMatch(powerShellLauncher, /Invoke-Expression/);
  });

  it('writes a syntactically valid POSIX launcher for homes containing apostrophes', { skip: process.platform === 'win32' }, () => {
    const root = makeRoot();
    const result = installStableLauncher({
      home: join(root, "o'brien"),
      platform: 'linux',
    });

    assert.doesNotThrow(() => {
      execFileSync('sh', ['-n', result.launcher], { stdio: 'pipe' });
    });
  });

  it('does not require chmod support to write Windows-only launcher files', () => {
    const writes = [];
    const fs = {
      mkdirSync() {},
      writeFileSync(path, content) {
        writes.push({ path, content });
      },
    };

    const result = installStableLauncher({
      home: '/managed-home',
      platform: 'win32',
      pathImpl: posix,
      fs,
    });

    assert.equal(result.commandLauncher, '/managed-home/.myelin/bin/myelin.cmd');
    assert.equal(writes.length, 2);
  });
});
