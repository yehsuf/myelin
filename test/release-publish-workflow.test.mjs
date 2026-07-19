import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import {
  loadWorkflow,
  findStepByName,
  makeTempGitRepo,
  commitMore,
  pushTag,
  runStepScript,
  runStepScriptWithGithubOutput,
  writeStubGh,
} from './workflow-test-helpers.mjs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const VALIDATION_WORKFLOW_PATH = '.github/workflows/release-validation.yml';
const PUBLISH_WORKFLOW_PATH = '.github/workflows/release-publish.yml';
const TRUST_STEP_NAME = 'Verify the triggering run is trusted (default branch, same repository)';

function loadPublishSteps() {
  return loadWorkflow(PUBLISH_WORKFLOW_PATH).jobs.publish.steps;
}

test('publisher workflow is triggered only by a successful validation workflow run, never dispatchable directly', () => {
  const workflow = loadWorkflow(PUBLISH_WORKFLOW_PATH);
  assert.ok(
    !Object.prototype.hasOwnProperty.call(workflow.on ?? {}, 'workflow_dispatch'),
    'the write-capable publisher must not be directly dispatchable',
  );
  assert.ok(
    Object.prototype.hasOwnProperty.call(workflow.on ?? {}, 'workflow_run'),
    'the publisher must be triggered by workflow_run',
  );

  const validationWorkflow = loadWorkflow(VALIDATION_WORKFLOW_PATH);
  assert.deepEqual(workflow.on.workflow_run.workflows, [validationWorkflow.name]);
  assert.ok(workflow.on.workflow_run.types.includes('completed'));
});

test('publisher defaults to read-only permissions; only the publish job elevates to write', () => {
  const workflow = loadWorkflow(PUBLISH_WORKFLOW_PATH);
  assert.equal(workflow.permissions?.contents, 'read');
  assert.equal(workflow.jobs.publish.permissions?.contents, 'write');
});

test('publisher requires the triggering run to have succeeded before any privileged action', () => {
  const workflow = loadWorkflow(PUBLISH_WORKFLOW_PATH);
  const condition = String(workflow.jobs.publish.if ?? '');
  assert.match(condition, /workflow_run\.conclusion/);
  assert.match(condition, /success/);
});

test('publisher job-level if: independently gates on head_repository, not just base repository', () => {
  const workflow = loadWorkflow(PUBLISH_WORKFLOW_PATH);
  const condition = String(workflow.jobs.publish.if ?? '');
  // `github.event.workflow_run.repository` is always the base (default) repository, even for
  // a workflow_run triggered by a fork PR -- it does not by itself exclude forks. The job-level
  // `if:` must also check `head_repository`, so fork-exclusion does not rest solely on the
  // in-job shell guard step (defense-in-depth: a future edit that drops the shell step must not
  // silently remove the fork exclusion).
  assert.match(condition, /workflow_run\.head_repository\.full_name\s*==\s*github\.repository/);
});

test('the trust-boundary guard is the first publisher step, before checkout and any privileged action', () => {
  const steps = loadPublishSteps();
  assert.equal(
    steps[0].name,
    TRUST_STEP_NAME,
    'the trust-boundary guard must be the very first step in the publish job',
  );
  assert.notEqual(steps[0].uses, 'actions/checkout@v4');
});

function runTrustGuard({ headRepo, baseRepo, headBranch, defaultBranch }) {
  const step = findStepByName(loadPublishSteps(), TRUST_STEP_NAME);
  return runStepScript(step.run, {
    env: {
      HEAD_REPO: headRepo,
      BASE_REPO: baseRepo,
      HEAD_BRANCH: headBranch,
      DEFAULT_BRANCH: defaultBranch,
    },
  });
}

test('publisher trust guard accepts only a same-repository run against the default branch', { skip: !existsSync('/bin/bash') }, () => {
  const trusted = runTrustGuard({
    headRepo: 'yehsuf/myelin', baseRepo: 'yehsuf/myelin', headBranch: 'main', defaultBranch: 'main',
  });
  assert.equal(trusted.status, 0, trusted.stderr);

  const wrongBranch = runTrustGuard({
    headRepo: 'yehsuf/myelin', baseRepo: 'yehsuf/myelin', headBranch: 'feature/evil', defaultBranch: 'main',
  });
  assert.notEqual(wrongBranch.status, 0);
  assert.match(wrongBranch.stderr, /Refusing to publish/);

  const forkRepo = runTrustGuard({
    headRepo: 'attacker/myelin', baseRepo: 'yehsuf/myelin', headBranch: 'main', defaultBranch: 'main',
  });
  assert.notEqual(forkRepo.status, 0);
  assert.match(forkRepo.stderr, /Refusing to publish/);

  const both = runTrustGuard({
    headRepo: 'attacker/myelin', baseRepo: 'yehsuf/myelin', headBranch: 'feature/evil', defaultBranch: 'main',
  });
  assert.notEqual(both.status, 0);
});

test('publisher checks out the triggering run\'s trusted commit, not any dispatch input', () => {
  const steps = loadPublishSteps();
  const checkout = steps.find((step) => step.uses?.startsWith('actions/checkout@'));
  assert.ok(checkout, 'expected a checkout step');
  assert.equal(checkout.with?.ref, '${{ github.event.workflow_run.head_sha }}');
});

test('publisher derives the release version from package.json and never trusts a workflow input', () => {
  const steps = loadPublishSteps();
  const deriveStep = findStepByName(steps, 'Derive release version from package.json');
  assert.match(deriveStep.run, /require\(['"]\.\/package\.json['"]\)\.version/);

  const serialized = JSON.stringify(steps);
  assert.doesNotMatch(serialized, /inputs\.version/, 'publisher must never read an untrusted workflow_dispatch input');
  assert.doesNotMatch(serialized, /github\.event\.inputs/, 'publisher must never read an untrusted workflow_dispatch input');
});

test('publisher requires the exact version format stable release discovery accepts, before tag/release creation', () => {
  const steps = loadPublishSteps();
  const versionGate = findStepByName(steps, 'Verify version matches stable release format');
  assert.match(versionGate.run, /verify-stable-version\.mjs/);

  const names = steps.map((step) => step.name);
  const gateIndex = names.indexOf('Verify version matches stable release format');
  const createIndex = names.indexOf('Create tag and GitHub release');
  assert.ok(
    gateIndex >= 0 && createIndex >= 0 && gateIndex < createIndex,
    'version format gate must run before tag/release creation',
  );
});

test('publisher pins and verifies the headroom-lite v0.31.0-2 tag exists before publishing', () => {
  const steps = loadPublishSteps();
  const pinCheck = findStepByName(steps, 'Verify headroom-lite v0.31.0-2 tag exists');
  assert.match(pinCheck.run, /headroom-lite\/git\/ref\/tags\/v0\.31\.0-2/);
});

function runTagCheckStep(dir, version) {
  const step = findStepByName(loadPublishSteps(), 'Verify release tag is safe to (re)create');
  return runStepScriptWithGithubOutput(step.run, { cwd: dir, env: { VERSION: version } });
}

test('publisher permits retrying a release after a tag push when the tag matches HEAD, and rejects a tag pointing elsewhere', { skip: !existsSync('/bin/bash') }, () => {
  // Case A: no tag pushed yet -- fresh release.
  {
    const { workDir } = makeTempGitRepo('publish-tagcheck-a-');
    const result = runTagCheckStep(workDir, '1.2.3');
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.output, /tag_exists=false/);
  }

  // Case B: tag already pushed at the exact commit being released -- safe retry.
  {
    const { workDir } = makeTempGitRepo('publish-tagcheck-b-');
    pushTag(workDir, 'v1.2.3');
    const result = runTagCheckStep(workDir, '1.2.3');
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.output, /tag_exists=true/);
  }

  // Case C: tag exists but points at a different commit -- must reject.
  {
    const { workDir } = makeTempGitRepo('publish-tagcheck-c-');
    pushTag(workDir, 'v1.2.3');
    commitMore(workDir);
    const result = runTagCheckStep(workDir, '1.2.3');
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /different commit|points at/i);
  }
});

function runReleaseCheckStep(version, { releaseExists }) {
  const stubDir = mkdtempSync(join(tmpdir(), 'publish-stub-gh-'));
  writeStubGh(stubDir, { releaseExists });
  const step = findStepByName(loadPublishSteps(), 'Verify GitHub release does not already exist');
  return runStepScript(step.run, {
    env: { VERSION: version, PATH: `${stubDir}:${process.env.PATH}` },
  });
}

test('publisher rejects retrying a release that has already been published', { skip: !existsSync('/bin/bash') }, () => {
  const missing = runReleaseCheckStep('1.2.3', { releaseExists: false });
  assert.equal(missing.status, 0, missing.stderr);

  const existing = runReleaseCheckStep('1.2.3', { releaseExists: true });
  assert.notEqual(existing.status, 0);
});

test('publisher only re-tags when the safe-retry check found no existing tag', () => {
  const steps = loadPublishSteps();
  const create = findStepByName(steps, 'Create tag and GitHub release');
  assert.match(create.run, /tag_exists/);
  assert.match(create.run, /gh release create/);
});
