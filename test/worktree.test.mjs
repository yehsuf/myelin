import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { basename, join, dirname } from 'node:path';
import { repoRoot, worktreeDir, crossPlatformTestCmds, runWorktreeAdd, runWorktreeRemove } from '../src/cli/worktree.mjs';

// ── pure function tests ──────────────────────────────────────────────────────

describe('worktreeDir', () => {
  it('produces a sibling directory with branch name sanitised', () => {
    const root = '/home/user/myelin';
    const dir  = worktreeDir(root, 'feat/auth-fix');
    assert.strictEqual(dir, '/home/user/myelin-wt-feat-auth-fix');
  });

  it('collapses repeated dashes and strips leading/trailing', () => {
    const dir = worktreeDir('/home/user/repo', '  --bad--name-- ');
    assert.ok(!dir.includes('--'));
    assert.ok(basename(dir).endsWith('-bad-name'));
  });

  it('handles simple branch names', () => {
    const dir = worktreeDir('/proj/tokenstack', 'main');
    assert.strictEqual(basename(dir), 'tokenstack-wt-main');
  });
});

describe('crossPlatformTestCmds', () => {
  it('includes branch name and test command', () => {
    const cmds = crossPlatformTestCmds('feat/x');
    assert.ok(cmds.windows.includes('feat/x'));
    assert.ok(cmds.linux.includes('feat/x'));
    assert.ok(cmds.windows.includes('npm test'));
    assert.ok(cmds.linux.includes('npm test'));
  });

  it('uses custom host names', () => {
    const cmds = crossPlatformTestCmds('feat/y', { winHost: 'my-win', linuxHost: 'my-lin' });
    assert.ok(cmds.windows.startsWith('ssh my-win'));
    assert.ok(cmds.linux.startsWith('ssh my-lin'));
  });
});

describe('repoRoot', () => {
  it('returns the git root when inside a repo', () => {
    const stub = () => Buffer.from('/home/user/repo\n');
    const root = repoRoot('/home/user/repo/src', stub);
    assert.strictEqual(root, '/home/user/repo');
  });

  it('returns null when not in a git repo', () => {
    const stub = () => { throw new Error('not a git repo'); };
    assert.strictEqual(repoRoot('/tmp', stub), null);
  });
});

// ── runWorktreeAdd (unit — stubs only, no real git) ──────────────────────────

describe('runWorktreeAdd', () => {
  function makeStubs({ rootExists = true, worktreeExists = false, addFails = false } = {}) {
    const calls = [];
    return {
      calls,
      execSync(cmd) {
        calls.push(cmd);
        if (cmd.includes('rev-parse')) return Buffer.from('/fake/repo\n');
        if (cmd.includes('worktree add') && addFails) throw new Error('already exists');
        return Buffer.from('');
      },
      existsSync() { return worktreeExists; },
      spawnSync() { return { status: 0 }; },
      log() {},
      warn() {},
    };
  }

  it('creates worktree and returns ok:true on success', async () => {
    const deps = makeStubs();
    const r = await runWorktreeAdd('feat/test', {}, deps);
    assert.ok(r.ok);
    assert.ok(deps.calls.some(c => c.includes('worktree add')));
  });

  it('returns ok:false when not in a git repo', async () => {
    const deps = makeStubs();
    deps.execSync = (cmd) => { if (cmd.includes('rev-parse')) throw new Error('no repo'); return Buffer.from(''); };
    const r = await runWorktreeAdd('feat/x', {}, deps);
    assert.strictEqual(r.ok, false);
  });

  it('skips worktree creation when dir already exists', async () => {
    const deps = makeStubs({ worktreeExists: true });
    await runWorktreeAdd('feat/x', {}, deps);
    assert.ok(!deps.calls.some(c => c.includes('worktree add')));
  });

  it('tries checkout of existing branch on add failure', async () => {
    const calls = [];
    const deps = {
      execSync(cmd) {
        calls.push(cmd);
        if (cmd.includes('rev-parse')) return Buffer.from('/fake/repo\n');
        // Match the flag ' -b ' not the string '-b' that may appear in branch names
        if (cmd.includes('worktree add') && / -b /.test(cmd)) throw new Error('branch exists');
        return Buffer.from('');
      },
      existsSync: () => false,
      spawnSync: () => ({ status: 0 }),
      log: () => {}, warn: () => {},
    };
    const r = await runWorktreeAdd('already-exists', {}, deps);
    assert.ok(r.ok);
    // Second add call should not include -b flag
    const addCalls = calls.filter(c => c.includes('worktree add'));
    assert.ok(addCalls.length === 2);
    assert.ok(!/ -b /.test(addCalls[1]));
  });
});

// ── runWorktreeRemove ────────────────────────────────────────────────────────

describe('runWorktreeRemove', () => {
  it('removes worktree and deletes branch', async () => {
    const calls = [];
    const deps = {
      execSync(cmd) { calls.push(cmd); if (cmd.includes('rev-parse')) return Buffer.from('/fake/repo\n'); return Buffer.from(''); },
      log: () => {}, warn: () => {},
    };
    const r = await runWorktreeRemove('feat/done', {}, deps);
    assert.ok(r.ok);
    assert.ok(calls.some(c => c.includes('worktree remove')));
    assert.ok(calls.some(c => c.includes('branch -d')));
  });

  it('respects --keepBranch flag', async () => {
    const calls = [];
    const deps = {
      execSync(cmd) { calls.push(cmd); if (cmd.includes('rev-parse')) return Buffer.from('/fake/repo\n'); return Buffer.from(''); },
      log: () => {}, warn: () => {},
    };
    await runWorktreeRemove('feat/done', { keepBranch: true }, deps);
    assert.ok(!calls.some(c => c.includes('branch')));
  });

  it('returns ok:false outside a git repo', async () => {
    const deps = {
      execSync() { throw new Error('no repo'); },
      log: () => {}, warn: () => {},
    };
    const r = await runWorktreeRemove('feat/x', {}, deps);
    assert.strictEqual(r.ok, false);
  });
});
