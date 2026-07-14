// Shared helpers for workflow contract tests. Not itself a *.test.mjs file,
// so `node --test test/**/*.test.mjs` does not pick it up as a test suite.
import { readFileSync, readdirSync, mkdtempSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { load } from 'js-yaml';
import assert from 'node:assert/strict';

export const WORKFLOWS_DIR = '.github/workflows';

export function loadWorkflow(path) {
  return load(readFileSync(path, 'utf8'));
}

export function listWorkflowFiles() {
  return readdirSync(WORKFLOWS_DIR).filter((file) => file.endsWith('.yml') || file.endsWith('.yaml'));
}

export function findStepByName(steps, name) {
  const step = steps.find((candidate) => candidate.name === name);
  assert.ok(step, `expected a step named "${name}"`);
  return step;
}

export function initBareRemote(dir) {
  execFileSync('git', ['init', '--bare', '--quiet', dir]);
}

export function initWorkingRepo(dir, remoteDir) {
  execFileSync('git', ['init', '--quiet', dir]);
  execFileSync('git', ['-C', dir, 'config', 'user.email', 'test@example.test']);
  execFileSync('git', ['-C', dir, 'config', 'user.name', 'Test']);
  writeFileSync(join(dir, 'file.txt'), 'content');
  execFileSync('git', ['-C', dir, 'add', '.']);
  execFileSync('git', ['-C', dir, 'commit', '--quiet', '-m', 'init']);
  execFileSync('git', ['-C', dir, 'remote', 'add', 'origin', remoteDir]);
  return execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
}

export function commitMore(dir) {
  writeFileSync(join(dir, 'more.txt'), 'more');
  execFileSync('git', ['-C', dir, 'add', '.']);
  execFileSync('git', ['-C', dir, 'commit', '--quiet', '-m', 'more']);
  return execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
}

export function pushTag(dir, tag) {
  execFileSync('git', ['-C', dir, 'tag', tag]);
  execFileSync('git', ['-C', dir, 'push', '--quiet', 'origin', tag]);
}

export function makeTempGitRepo(prefix = 'workflow-test-') {
  const remoteDir = mkdtempSync(join(tmpdir(), `${prefix}remote-`));
  const workDir = mkdtempSync(join(tmpdir(), `${prefix}work-`));
  initBareRemote(remoteDir);
  initWorkingRepo(workDir, remoteDir);
  return { remoteDir, workDir };
}

export function runStepScript(script, { cwd = process.cwd(), env = {} } = {}) {
  return spawnSync('bash', ['-c', script], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

export function runStepScriptWithGithubOutput(script, { cwd, env = {} }) {
  const outputFile = join(cwd, 'github-output.txt');
  writeFileSync(outputFile, '');
  const result = runStepScript(script, { cwd, env: { ...env, GITHUB_OUTPUT: outputFile } });
  return { ...result, output: readFileSync(outputFile, 'utf8') };
}

export function writeStubGh(dir, { releaseExists }) {
  const ghPath = join(dir, 'gh');
  writeFileSync(
    ghPath,
    `#!/bin/sh\nif [ "$1" = "release" ] && [ "$2" = "view" ]; then\n  exit ${releaseExists ? 0 : 1}\nfi\nexit 1\n`,
  );
  chmodSync(ghPath, 0o755);
  return dir;
}
