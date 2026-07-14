// Review-fix suite for the reconcile/atomic-update-backend-selection branch.
// Each block corresponds to a confirmed finding (RED->GREEN).
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

const temporaryRoots = [];
function makeRoot(tag) {
  const root = fs.mkdtempSync(join(process.cwd(), `.test-reconcile-${tag}-`));
  temporaryRoots.push(root);
  return root;
}
afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Finding 8: pin actions/checkout and actions/setup-node in the write-capable
// publisher workflow to immutable 40-hex commit SHAs.
// ---------------------------------------------------------------------------
describe('finding 8: release publisher pins actions to immutable SHAs', () => {
  const workflow = fs.readFileSync(
    join(repoRoot, '.github/workflows/release-publish.yml'),
    'utf8',
  );

  it('does not reference mutable action tags for checkout/setup-node', () => {
    assert.doesNotMatch(workflow, /uses:\s*actions\/checkout@v\d/u);
    assert.doesNotMatch(workflow, /uses:\s*actions\/setup-node@v\d/u);
  });

  it('pins checkout and setup-node to full commit SHAs', () => {
    const pinned = [...workflow.matchAll(/uses:\s*actions\/(checkout|setup-node)@([^\s#]+)/gu)];
    assert.equal(pinned.length, 2, 'expected exactly checkout + setup-node');
    for (const match of pinned) {
      assert.match(match[2], /^[0-9a-f]{40}$/u, `${match[1]} must be pinned to a 40-hex SHA`);
    }
  });
});

// ---------------------------------------------------------------------------
// Finding 7: WinSW (github-binary) staging must fail closed unless a checksum
// is verified. WinSW publishes no per-asset digest and no checksum manifest,
// so verification relies on reviewer-pinned manifest checksums.
// ---------------------------------------------------------------------------
import { COMPONENTS } from '../src/update/component-manifest.mjs';
import { stageComponent } from '../src/update/component-installers.mjs';

function stageStatus(type = 'directory') {
  return {
    isDirectory() { return type === 'directory'; },
    isFile() { return type === 'file'; },
    isSymbolicLink() { return type === 'symlink'; },
  };
}
function stageFakeFs() {
  const existing = new Map();
  return {
    existing,
    mkdirSync(p) { existing.set(p, stageStatus('directory')); },
    writeFileSync(p) { existing.set(p, stageStatus('file')); },
    chmodSync() {},
    lstatSync(p) {
      const status = existing.get(p);
      if (status) return status;
      const error = new Error(`ENOENT: ${p}`);
      error.code = 'ENOENT';
      throw error;
    },
  };
}

const WINSW_DOWNLOAD = 'https://github.com/winsw/winsw/releases/download/v3.0.0-alpha.11/WinSW-x64.exe';

function winswRelease() {
  return JSON.stringify({
    tag_name: 'v3.0.0-alpha.11',
    assets: [
      { name: 'WinSW-x64.exe', browser_download_url: WINSW_DOWNLOAD, digest: null },
      { name: 'WinSW-net461.exe', browser_download_url: 'https://github.com/winsw/winsw/releases/download/v3.0.0-alpha.11/WinSW-net461.exe', digest: null },
    ],
  });
}

function winswExec(binary) {
  return (file, args) => {
    const last = String(args.at(-1));
    if (last.includes('/releases/tags/')) return winswRelease();
    if (last === WINSW_DOWNLOAD) return binary;
    throw new Error(`unexpected command: ${file} ${args.join(' ')}`);
  };
}

describe('finding 7: WinSW staging fails closed without a verified checksum', () => {
  const baseComponent = {
    kind: 'github-binary',
    repository: 'winsw/winsw',
    version: '3.0.0-alpha.11',
    ref: 'v3.0.0-alpha.11',
    bin: 'WinSW.exe',
    requireVerifiedChecksum: true,
  };

  it('refuses to stage when no checksum can be verified', () => {
    const binary = Buffer.from('unverifiable-winsw-bytes');
    assert.throws(
      () => stageComponent({
        name: 'winsw',
        component: baseComponent,
        root: 'C:\\components',
        platform: { os: 'windows', arch: 'x64' },
        fs: stageFakeFs(),
        exec: winswExec(binary),
      }),
      (error) => {
        assert.equal(error.code, 'ERR_COMPONENT_CHECKSUM_MISSING');
        return true;
      },
    );
  });

  it('stages successfully when the reviewer-pinned checksum matches the bytes', () => {
    const binary = Buffer.from('verified-winsw-bytes');
    const result = stageComponent({
      name: 'winsw',
      component: { ...baseComponent, checksums: { 'WinSW-x64.exe': sha256(binary) } },
      root: 'C:\\components',
      platform: { os: 'windows', arch: 'x64' },
      fs: stageFakeFs(),
      exec: winswExec(binary),
    });
    assert.equal(result.checksum.verified, true);
    assert.equal(result.checksum.source, 'manifest-pinned');
  });

  it('rejects a tampered binary whose bytes do not match the pinned checksum', () => {
    const pinnedFor = Buffer.from('the-real-bytes');
    const tampered = Buffer.from('tampered-bytes');
    assert.throws(
      () => stageComponent({
        name: 'winsw',
        component: { ...baseComponent, checksums: { 'WinSW-x64.exe': sha256(pinnedFor) } },
        root: 'C:\\components',
        platform: { os: 'windows', arch: 'x64' },
        fs: stageFakeFs(),
        exec: winswExec(tampered),
      }),
      (error) => {
        assert.equal(error.code, 'ERR_COMPONENT_CHECKSUM_MISMATCH');
        return true;
      },
    );
  });

  it('pins reviewed WinSW checksums in the component manifest', () => {
    const winsw = COMPONENTS.winsw;
    assert.equal(winsw.requireVerifiedChecksum, true);
    assert.equal(
      winsw.checksums['WinSW-x64.exe'],
      'a2daa6a33a9c2b791ae31d9092e7935c339d1e03e89bfb747618ce2f4e819e20',
    );
    assert.equal(
      winsw.checksums['WinSW-x86.exe'],
      '3201432b44825b0dc763eb4052dc84b179314e2a338794c9f5f797e8fe2bb0fc',
    );
    assert.equal(
      winsw.checksums['WinSW-net461.exe'],
      '91bce26b4fa3a7534e7967c1804d7417737b7169014435e5b3b31924bf19f3ee',
    );
  });
});

// ---------------------------------------------------------------------------
// Finding 6: lock release must be ownership-preserving. If a concurrent
// reclaim replaces the lock file in the race window between the ownership
// check and the destructive removal, release must NOT unlink the reclaimed
// lock; it must fence instead.
// ---------------------------------------------------------------------------
import * as nodeFs from 'node:fs';
import {
  createUpdateLock,
  UPDATE_LOCK_SCHEMA_VERSION,
} from '../src/update/update-orchestrator.mjs';

describe('finding 6: release preserves a concurrently reclaimed lock', () => {
  it('does not unlink a lock that was reclaimed during release', () => {
    const root = makeRoot('lock6');
    const lockPath = join(root, 'update.lock');

    const lock = createUpdateLock({ isPidAlive: () => true });
    const owner = lock.acquire(lockPath);

    const reclaimer = {
      schemaVersion: UPDATE_LOCK_SCHEMA_VERSION,
      token: '11111111-1111-4111-8111-111111111111',
      pid: owner.pid + 1000,
      startedAt: Date.now(),
      heartbeatAt: Date.now(),
    };

    // Wrap the real filesystem so the first destructive op on the lock path is
    // preceded by a concurrent reclaim overwriting the lock with a new owner.
    let injected = false;
    const injectReclaim = (targetPath) => {
      if (!injected && targetPath === lockPath) {
        injected = true;
        nodeFs.writeFileSync(lockPath, JSON.stringify(reclaimer));
      }
    };
    const racyFs = { ...nodeFs };
    racyFs.unlinkSync = (p, ...rest) => {
      injectReclaim(p);
      return nodeFs.unlinkSync(p, ...rest);
    };
    racyFs.renameSync = (from, ...rest) => {
      injectReclaim(from);
      return nodeFs.renameSync(from, ...rest);
    };

    const racyLock = createUpdateLock({ fs: racyFs, isPidAlive: () => true });

    assert.throws(
      () => racyLock.release(owner, lockPath),
      (error) => {
        assert.equal(error.code, 'ERR_UPDATE_FENCED');
        return true;
      },
    );

    // The reclaimed lock must still be present and owned by the reclaimer.
    assert.equal(nodeFs.existsSync(lockPath), true, 'reclaimed lock must not be unlinked');
    const survivor = JSON.parse(nodeFs.readFileSync(lockPath, 'utf8'));
    assert.equal(survivor.token, reclaimer.token);
    assert.equal(survivor.pid, reclaimer.pid);
  });

  it('cleanly releases a lock it still owns', () => {
    const root = makeRoot('lock6b');
    const lockPath = join(root, 'update.lock');
    const lock = createUpdateLock({ isPidAlive: () => true });
    const owner = lock.acquire(lockPath);
    lock.release(owner, lockPath);
    assert.equal(nodeFs.existsSync(lockPath), false);
  });
});

// ---------------------------------------------------------------------------
// Finding 6 (critical follow-up): the ownership-preserving release must never
// RESTORE its moved-aside record over a lock a third process acquired while the
// path was momentarily free. Deterministic three-process interleaving:
//   P1 owns the lock and begins release (ownership check passes).
//   P2 reclaims P1's (now stale) lock, so the path holds P2's record.
//   P1 moves the path aside (capturing P2's record) — the path is now free.
//   P3 acquires the momentarily free path.
//   P1 finds the moved record is not its own and attempts to restore it; this
//   restore must NOT clobber P3's freshly acquired lock.
// ---------------------------------------------------------------------------
describe('finding 6 (critical): release never restores over an intervening acquisition', () => {
  it("preserves a third process's lock acquired while ours was moved aside", () => {
    const root = makeRoot('lock6c');
    const lockPath = join(root, 'update.lock');

    const owner = createUpdateLock({ isPidAlive: () => true }).acquire(lockPath);

    const reclaimer = {
      schemaVersion: UPDATE_LOCK_SCHEMA_VERSION,
      token: '22222222-2222-4222-8222-222222222222',
      pid: owner.pid + 2000,
      startedAt: Date.now(),
      heartbeatAt: Date.now(),
    };
    const intruder = {
      schemaVersion: UPDATE_LOCK_SCHEMA_VERSION,
      token: '33333333-3333-4333-8333-333333333333',
      pid: owner.pid + 3000,
      startedAt: Date.now(),
      heartbeatAt: Date.now(),
    };

    // Interleave all three processes deterministically at P1's move-aside
    // rename (path -> release-scoped path).
    let injected = false;
    const racyFs = { ...nodeFs };
    racyFs.renameSync = (from, to, ...rest) => {
      if (!injected && from === lockPath) {
        injected = true;
        // P2 reclaimed P1's stale lock: the path now holds the reclaimer.
        nodeFs.writeFileSync(lockPath, JSON.stringify(reclaimer));
        // P1 performs the move-aside (capturing P2's record); path is now free.
        const result = nodeFs.renameSync(lockPath, to, ...rest);
        // P3 acquires the momentarily free path.
        nodeFs.writeFileSync(lockPath, JSON.stringify(intruder));
        return result;
      }
      return nodeFs.renameSync(from, to, ...rest);
    };

    const racyLock = createUpdateLock({ fs: racyFs, isPidAlive: () => true });

    assert.throws(
      () => racyLock.release(owner, lockPath),
      (error) => {
        assert.equal(error.code, 'ERR_UPDATE_FENCED');
        return true;
      },
    );

    // P3's freshly acquired lock must survive — release must not restore the
    // moved-aside reclaimer record over it.
    assert.equal(nodeFs.existsSync(lockPath), true, 'the intervening lock must remain');
    const survivor = JSON.parse(nodeFs.readFileSync(lockPath, 'utf8'));
    assert.equal(survivor.token, intruder.token, 'must not clobber the third process lock');
    assert.equal(survivor.pid, intruder.pid);

    // The moved-aside record must not be left orphaned as a live lock file.
    assert.equal(
      nodeFs.existsSync(`${lockPath}.release-${owner.token}`),
      false,
      'the aside copy must be cleaned up, not left behind',
    );
  });

  it('fails closed on a hard-link-unsupported filesystem instead of restoring over an acquisition', () => {
    const root = makeRoot('lock6d');
    const lockPath = join(root, 'update.lock');
    const releasePathOf = (token) => `${lockPath}.release-${token}`;

    const owner = createUpdateLock({ isPidAlive: () => true }).acquire(lockPath);

    const reclaimer = {
      schemaVersion: UPDATE_LOCK_SCHEMA_VERSION,
      token: '44444444-4444-4444-8444-444444444444',
      pid: owner.pid + 4000,
      startedAt: Date.now(),
      heartbeatAt: Date.now(),
    };
    const intruder = {
      schemaVersion: UPDATE_LOCK_SCHEMA_VERSION,
      token: '55555555-5555-4555-8555-555555555555',
      pid: owner.pid + 5000,
      startedAt: Date.now(),
      heartbeatAt: Date.now(),
    };
    const releasePath = releasePathOf(owner.token);

    let movedAside = false;
    let intruderPlaced = false;
    const placeIntruder = () => {
      if (!intruderPlaced) {
        intruderPlaced = true;
        nodeFs.writeFileSync(lockPath, JSON.stringify(intruder));
      }
    };

    const racyFs = { ...nodeFs };
    // Hard links are unavailable on this filesystem.
    racyFs.linkSync = () => {
      const error = new Error('link() not supported');
      error.code = 'ENOSYS';
      throw error;
    };
    racyFs.renameSync = (from, to, ...rest) => {
      if (!movedAside && from === lockPath) {
        movedAside = true;
        // P2 reclaimed P1's stale lock: the path now holds the reclaimer.
        nodeFs.writeFileSync(lockPath, JSON.stringify(reclaimer));
        // P1 moves the reclaimer aside; the path is now free.
        return nodeFs.renameSync(lockPath, to, ...rest);
      }
      if (from === releasePath && to === lockPath) {
        // Read-then-rename fallback window: P3 acquires just before the rename.
        placeIntruder();
        return nodeFs.renameSync(from, to, ...rest);
      }
      return nodeFs.renameSync(from, to, ...rest);
    };
    racyFs.openSync = (p, flags, ...rest) => {
      if (p === lockPath && flags === 'wx') {
        // Exclusive-create restore window: P3 acquires just before the create.
        placeIntruder();
      }
      return nodeFs.openSync(p, flags, ...rest);
    };

    const racyLock = createUpdateLock({ fs: racyFs, isPidAlive: () => true });

    assert.throws(
      () => racyLock.release(owner, lockPath),
      (error) => {
        assert.equal(error.code, 'ERR_UPDATE_FENCED');
        return true;
      },
    );

    // Regardless of the fallback mechanism, P3's lock must survive.
    assert.equal(nodeFs.existsSync(lockPath), true, 'the intervening lock must remain');
    const survivor = JSON.parse(nodeFs.readFileSync(lockPath, 'utf8'));
    assert.equal(survivor.token, intruder.token, 'must not clobber the third process lock');
    assert.equal(survivor.pid, intruder.pid);
    assert.equal(
      nodeFs.existsSync(releasePath),
      false,
      'the aside copy must be cleaned up, not left behind',
    );
  });
});

// ---------------------------------------------------------------------------
// Finding 5: on WSL, detectOS() reports 'windows' to bridge Windows service
// management, but the filesystem is POSIX. Component/release/lock/journal
// storage must therefore use POSIX path semantics, while service management
// stays on the Windows platform.
// ---------------------------------------------------------------------------
import {
  createUpdateDependencies,
  resolveStoragePlatform,
} from '../src/update/update-orchestrator.mjs';

describe('finding 5: WSL update storage uses POSIX path semantics', () => {
  it('maps a WSL (windows-bridged) platform to POSIX storage', () => {
    assert.equal(resolveStoragePlatform('windows', { wsl: true }), 'linux');
    assert.equal(resolveStoragePlatform('windows', { wsl: false }), 'windows');
    assert.equal(resolveStoragePlatform('linux', { wsl: false }), 'linux');
    assert.equal(resolveStoragePlatform('darwin', {}), 'darwin');
  });

  function stagingPathProbe(storagePlatform) {
    const home = makeRoot('wsl5');
    const captured = [];
    const spyFs = {
      ...nodeFs,
      lstatSync(p) {
        captured.push(String(p));
        const error = new Error(`ENOENT: ${p}`);
        error.code = 'ENOENT';
        throw error;
      },
    };
    const deps = createUpdateDependencies({
      home,
      platform: 'windows',
      storagePlatform,
      fs: spyFs,
    });
    return { deps, captured };
  }

  it('threads POSIX storage platform into component staging checks', async () => {
    const { deps, captured } = stagingPathProbe('linux');
    await deps.isComponentStaged({ name: 'rtk', component: { version: '0.43.0' } });
    assert.equal(captured.length, 1);
    assert.doesNotMatch(captured[0], /\\/u, 'POSIX storage must not emit Windows separators');
  });

  it('still honours a genuine Windows storage platform', async () => {
    const { deps, captured } = stagingPathProbe('windows');
    await deps.isComponentStaged({ name: 'rtk', component: { version: '0.43.0' } });
    assert.equal(captured.length, 1);
    assert.match(captured[0], /\\/u, 'Windows storage must emit Windows separators');
  });
});

// ---------------------------------------------------------------------------
// Finding 1: every install side effect must run behind a mutation fence backed
// by a held update lock. A `--update-apply` request must additionally validate
// the transaction environment the orchestrator exported (token, staged-release
// directory, config path) before touching anything, and re-assert the nested
// lock; an ordinary install re-asserts its own global lock. A missing/mismatched
// lock or environment fails closed so nothing mutates unauthenticated.
// ---------------------------------------------------------------------------
import {
  assertStagedApplyAuthorization,
  createInstallMutationFence,
  resolveStagedCompressionBinary,
} from '../src/install.mjs';

describe('finding 1: staged-apply authorization is validated against the exported environment', () => {
  const validEnv = {
    MYELIN_UPDATE_TRANSACTION_TOKEN: 'tok-123',
    MYELIN_UPDATE_STAGED_RELEASE: '/opt/rel/current',
    MYELIN_UPDATE_CONFIG_PATH: '/opt/cfg/config.yaml',
  };
  const validFlags = {
    'update-apply': true,
    'update-token': 'tok-123',
    'staged-release': '/opt/rel/current',
  };
  const okLock = () => ({ assertHeld() {} });

  it('rejects a request whose token does not match the exported transaction token', () => {
    assert.throws(
      () => assertStagedApplyAuthorization({
        flags: { ...validFlags, 'update-token': 'wrong' },
        env: validEnv,
        configPath: '/opt/cfg/config.yaml',
        lockPath: '/lock',
        createLock: okLock,
      }),
      /Invalid staged update apply request/u,
    );
  });

  it('rejects a request whose config path does not match the exported config path', () => {
    assert.throws(
      () => assertStagedApplyAuthorization({
        flags: validFlags,
        env: validEnv,
        configPath: '/somewhere/else.yaml',
        lockPath: '/lock',
        createLock: okLock,
      }),
      /Invalid staged update apply request/u,
    );
  });

  it('fails closed when the update lock is not held by the nested token', () => {
    assert.throws(
      () => assertStagedApplyAuthorization({
        flags: validFlags,
        env: validEnv,
        configPath: '/opt/cfg/config.yaml',
        lockPath: '/lock',
        createLock: () => ({ assertHeld() { throw new Error('lock is fenced'); } }),
      }),
      /lock is fenced/u,
    );
  });

  it('asserts the nested lock and returns the validated token on success', () => {
    let held = null;
    const token = assertStagedApplyAuthorization({
      flags: validFlags,
      env: validEnv,
      configPath: '/opt/cfg/config.yaml',
      lockPath: '/lock',
      createLock: () => ({ assertHeld(tok, path) { held = { tok, path }; } }),
    });
    assert.equal(token, 'tok-123');
    assert.deepEqual(held.tok, { token: 'tok-123' });
    assert.equal(held.path, '/lock');
  });
});

describe('finding 1: the mutation fence requires a held lock before any side effect', () => {
  it('throws when neither a staged token nor a global install lock is held', () => {
    const fence = createInstallMutationFence({
      nestedToken: null,
      installGlobalLock: null,
      lockPath: '/lock',
    });
    assert.throws(() => fence(), /held global update lock/u);
  });

  it('re-asserts the nested lock on every staged-apply mutation', () => {
    let calls = 0;
    const fence = createInstallMutationFence({
      nestedToken: 'ntok',
      installGlobalLock: null,
      lockPath: '/lock',
      createLock: () => ({
        assertHeld(tok, path) {
          calls += 1;
          assert.deepEqual(tok, { token: 'ntok' });
          assert.equal(path, '/lock');
        },
      }),
    });
    fence();
    fence();
    assert.equal(calls, 2);
  });

  it('re-asserts the ordinary-install global lock on every mutation', () => {
    let held = null;
    const installGlobalLock = {
      lock: { assertHeld(tok, path) { held = { tok, path }; } },
      token: { token: 'gtok', pid: 4242 },
    };
    const fence = createInstallMutationFence({
      nestedToken: null,
      installGlobalLock,
      lockPath: '/lock',
    });
    fence();
    assert.deepEqual(held.tok, { token: 'gtok', pid: 4242 });
    assert.equal(held.path, '/lock');
  });
});

// ---------------------------------------------------------------------------
// Finding 2: a compression-disabled proxy update must never resolve or stage a
// managed compression binary. When `proxy.compression.enabled === false` the
// selected backend is 'disabled' and no compression executable may be resolved.
// ---------------------------------------------------------------------------
describe('finding 2: disabled compression stages no compression binary', () => {
  it('returns null and never resolves a binary when compression is disabled', () => {
    let calls = 0;
    const bin = resolveStagedCompressionBinary({
      updateApply: true,
      cfg: { proxy: { compression: { enabled: false }, engine: 'headroom_lite' } },
      componentsRoot: '/components',
      platform: 'linux',
      resolveBinary: () => { calls += 1; return { binPath: '/should/not/happen' }; },
    });
    assert.equal(bin, null);
    assert.equal(calls, 0);
  });

  it('resolves the pinned headroom-lite binary when compression is enabled', () => {
    let seen = null;
    const bin = resolveStagedCompressionBinary({
      updateApply: true,
      cfg: { proxy: { engine: 'headroom_lite' } },
      componentsRoot: '/components',
      platform: 'linux',
      resolveBinary: (args) => { seen = args; return { binPath: '/managed/headroom-lite' }; },
    });
    assert.equal(bin, '/managed/headroom-lite');
    assert.equal(seen.backend, 'headroom-lite');
    assert.equal(seen.componentsRoot, '/components');
    assert.equal(seen.platform, 'linux');
  });

  it('maps the canonical headroom engine to the headroom-original backend', () => {
    const bin = resolveStagedCompressionBinary({
      updateApply: true,
      cfg: { proxy: { engine: 'headroom' } },
      componentsRoot: '/components',
      platform: 'linux',
      resolveBinary: (args) => ({ binPath: `bin-${args.backend}` }),
    });
    assert.equal(bin, 'bin-headroom-original');
  });

  it('resolves nothing outside of a staged apply', () => {
    let calls = 0;
    const bin = resolveStagedCompressionBinary({
      updateApply: false,
      cfg: { proxy: { engine: 'headroom_lite' } },
      componentsRoot: '/components',
      platform: 'linux',
      resolveBinary: () => { calls += 1; return { binPath: 'x' }; },
    });
    assert.equal(bin, null);
    assert.equal(calls, 0);
  });
});

// ---------------------------------------------------------------------------
// Finding 3: under `--update-apply` the installer must suppress every global
// (unpinned) component install and the one-time legacy migration, and it must
// fence each numbered mutation phase. These are the sites the transaction relies
// on to avoid mutating legacy/global state.
// ---------------------------------------------------------------------------
describe('finding 3: staged apply suppresses global component installs and fences each phase', () => {
  const source = fs.readFileSync(join(repoRoot, 'src/install.mjs'), 'utf8');

  it('derives the global-install gate from --update-apply', () => {
    assert.match(source, /const runGlobalComponentInstalls = !flags\['update-apply'\];/u);
  });

  it('skips the one-time legacy migration during a staged apply', () => {
    assert.match(source, /!flags\['dry-run'\] && !flags\['update-apply'\]/u);
  });

  it('gates the package manager, code-discovery, headroom and rtk installs on the gate', () => {
    assert.match(source, /if \(runGlobalComponentInstalls\) \{\s*\n\s*await ensureUv\(\);/u);
    assert.match(source, /!tools\.headroom\.installed && runGlobalComponentInstalls/u);
    assert.match(source, /!tools\.rtk\.installed && runGlobalComponentInstalls/u);
  });

  it('threads the gate into the mitmproxy install-if-missing option', () => {
    assert.match(source, /ensureMitmproxy\(os, \{ installIfMissing: runGlobalComponentInstalls \}\)/u);
  });

  it('fences every numbered mutation phase before it runs', () => {
    for (const phase of ['[1/7]', '[2/7]', '[3/7]', '[4/7] Background service', '[5/7]']) {
      const stepIdx = source.indexOf(`step('${phase}`);
      assert.notEqual(stepIdx, -1, `phase ${phase} present`);
      const afterStep = source.slice(stepIdx, stepIdx + 160);
      assert.match(afterStep, /assertInstallMutationFence\(\);/u, `phase ${phase} is fenced`);
    }
  });
});
