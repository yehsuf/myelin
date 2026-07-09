import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { isRepoDirty, runSelfUpdate } from '../src/cli/update.mjs';

function makeRepoFixture() {
  const repoDir = mkdtempSync(join(homedir(), '.tokenstack-update-test-'));
  mkdirSync(join(repoDir, '.serena', 'memories'), { recursive: true });
  writeFileSync(join(repoDir, 'tracked.txt'), 'clean\n', 'utf8');
  writeFileSync(join(repoDir, '.serena', '.gitignore'), '/cache\n/project.local.yml\n/project.yml\n/memories/\n', 'utf8');
  writeFileSync(join(repoDir, '.serena', 'project.yml'), 'project: fixture\n', 'utf8');
  execFileSync('git', ['init'], { cwd: repoDir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'Myelin Test'], { cwd: repoDir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'myelin-test@example.com'], { cwd: repoDir, stdio: 'ignore' });
  execFileSync('git', ['add', 'tracked.txt', '.serena/.gitignore'], { cwd: repoDir, stdio: 'ignore' });
  execFileSync('git', ['add', '-f', '.serena/project.yml'], { cwd: repoDir, stdio: 'ignore' });
  execFileSync('git', ['commit', '-m', 'fixture'], { cwd: repoDir, stdio: 'ignore' });
  execFileSync('git', ['rm', '--cached', '.serena/project.yml'], { cwd: repoDir, stdio: 'ignore' });
  execFileSync('git', ['commit', '-m', 'untrack serena project'], { cwd: repoDir, stdio: 'ignore' });
  return repoDir;
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

function makeSelfUpdateExecSyncStub({ current = '83c7d35', latest = 'c6e333d', unpushed = '' } = {}) {
  const calls = [];
  return {
    calls,
    execSync(command) {
      calls.push(command);
      if (command === 'git rev-parse --short HEAD') return Buffer.from(`${current}\n`);
      if (command === 'git fetch origin') return Buffer.from('');
      if (command === 'git rev-parse --short origin/main') return Buffer.from(`${latest}\n`);
      if (command === 'git log origin/main..HEAD --oneline') return Buffer.from(unpushed ? `${unpushed}\n` : '');
      if (command === 'git merge --ff-only origin/main') return Buffer.from('');
      if (command === 'npm install --registry https://registry.npmjs.org') return Buffer.from('');
      if (command.includes('src/install.mjs') && command.endsWith('" --yes')) return Buffer.from('');
      throw new Error(`Unexpected execSync command: ${command}`);
    },
  };
}

describe('isRepoDirty', () => {
  it('ignores changes confined to .serena/', () => {
    const repoDir = makeRepoFixture();
    try {
      writeFileSync(join(repoDir, '.serena', 'project.yml'), 'project: changed\n', 'utf8');
      writeFileSync(join(repoDir, '.serena', 'memories', 'note.txt'), 'remember me\n', 'utf8');

      assert.equal(isRepoDirty(repoDir), '');
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it('still detects a tracked modification outside .serena/', () => {
    const repoDir = makeRepoFixture();
    try {
      const trackedPath = join(repoDir, 'tracked.txt');
      writeFileSync(trackedPath, readFileSync(trackedPath, 'utf8') + 'dirty\n', 'utf8');

      assert.match(isRepoDirty(repoDir), /tracked\.txt/);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });
});

describe('runSelfUpdate', () => {
  it('bypasses the dirty-working-tree abort when --force is set', async () => {
    const repoDir = makeRepoFixture();
    try {
      const trackedPath = join(repoDir, 'tracked.txt');
      writeFileSync(trackedPath, readFileSync(trackedPath, 'utf8') + 'dirty\n', 'utf8');
      const consoleCapture = captureConsole();
      const execStub = makeSelfUpdateExecSyncStub();

      const result = await runSelfUpdate(
        { force: true },
        { repoDir, execSync: execStub.execSync, log: consoleCapture.log, warn: consoleCapture.warn }
      );

      assert.equal(result.status, 'updated');
      assert.equal(result.bypassed, true);
      assert.ok(execStub.calls.includes('git rev-parse --short HEAD'));
      assert.match(consoleCapture.warns.join('\n'), /--force specified/);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it('still aborts with the exact warning when the repo is dirty and --force is omitted', async () => {
    const repoDir = makeRepoFixture();
    try {
      const trackedPath = join(repoDir, 'tracked.txt');
      writeFileSync(trackedPath, readFileSync(trackedPath, 'utf8') + 'dirty\n', 'utf8');
      const consoleCapture = captureConsole();
      const execStub = makeSelfUpdateExecSyncStub();

      const result = await runSelfUpdate(
        {},
        { repoDir, execSync: execStub.execSync, log: consoleCapture.log, warn: consoleCapture.warn }
      );

      assert.equal(result.status, 'aborted-dirty');
      assert.equal(result.bypassed, false);
      assert.deepEqual(execStub.calls, []);
      assert.deepEqual(consoleCapture.warns, [
        '  ✗ Uncommitted changes present — aborting self-update to avoid data loss.',
        '    Commit or stash your changes, then re-run: myelin update --self\n',
      ]);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it('does not print a bypass warning when only .serena/ is dirty, even with --force', async () => {
    const repoDir = makeRepoFixture();
    try {
      writeFileSync(join(repoDir, '.serena', 'project.yml'), 'project: changed\n', 'utf8');
      writeFileSync(join(repoDir, '.serena', 'memories', 'note.txt'), 'remember me\n', 'utf8');
      const consoleCapture = captureConsole();
      const execStub = makeSelfUpdateExecSyncStub();

      const result = await runSelfUpdate(
        { force: true },
        { repoDir, execSync: execStub.execSync, log: consoleCapture.log, warn: consoleCapture.warn }
      );

      assert.equal(result.status, 'updated');
      assert.equal(result.bypassed, false);
      assert.ok(execStub.calls.includes('git rev-parse --short HEAD'));
      assert.equal(consoleCapture.warns.length, 0);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });
});
