import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { isRepoDirty } from '../src/cli/update.mjs';

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
