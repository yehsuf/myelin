import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadWorkflow, WORKFLOWS_DIR } from './workflow-test-helpers.mjs';

const VALIDATION_WORKFLOW_PATH = '.github/workflows/release-validation.yml';

test('release validation workflow is manually dispatched and gates only the cross-platform test matrix', () => {
  const workflow = loadWorkflow(VALIDATION_WORKFLOW_PATH);
  assert.ok(
    Object.prototype.hasOwnProperty.call(workflow.on ?? {}, 'workflow_dispatch'),
    'the validation workflow must remain manually dispatchable',
  );
  const matrix = workflow.jobs.test.strategy.matrix.os;
  assert.deepEqual(matrix, [
    'macos-latest',
    'windows-latest',
    'ubuntu-latest',
  ]);
});

test('release validation workflow never holds a write token or performs any release action', () => {
  const workflow = loadWorkflow(VALIDATION_WORKFLOW_PATH);
  assert.equal(workflow.permissions?.contents, 'read');
  for (const [jobName, job] of Object.entries(workflow.jobs)) {
    assert.notEqual(
      job.permissions?.contents,
      'write',
      `job "${jobName}" in the manually dispatched validation workflow must never hold a write token`,
    );
  }
  const serialized = JSON.stringify(workflow.jobs);
  assert.doesNotMatch(serialized, /gh release create/, 'validation workflow must never publish a release');
  assert.doesNotMatch(serialized, /git push origin/, 'validation workflow must never push a tag');
  assert.doesNotMatch(serialized, /\bgit tag\b/, 'validation workflow must never create a tag');
});

test('no manually dispatchable workflow in this repository grants a write token to any job', () => {
  const files = readdirSync(WORKFLOWS_DIR).filter((file) => file.endsWith('.yml') || file.endsWith('.yaml'));
  assert.ok(files.length > 0, 'expected at least one workflow file');

  const dispatchable = [];
  for (const file of files) {
    const workflow = loadWorkflow(join(WORKFLOWS_DIR, file));
    const isDispatchable = Object.prototype.hasOwnProperty.call(workflow.on ?? {}, 'workflow_dispatch');
    if (!isDispatchable) continue;
    dispatchable.push(file);

    assert.notEqual(
      workflow.permissions?.contents,
      'write',
      `${file} is manually dispatchable and must not declare contents: write at the workflow level`,
    );
    for (const [jobName, job] of Object.entries(workflow.jobs ?? {})) {
      assert.notEqual(
        job.permissions?.contents,
        'write',
        `${file}#${jobName} is reachable via workflow_dispatch and must not declare contents: write`,
      );
    }
  }

  // The scan itself must actually have exercised at least the validation
  // workflow, otherwise the assertions above would vacuously pass.
  assert.ok(
    dispatchable.some((file) => readFileSync(join(WORKFLOWS_DIR, file), 'utf8').includes('workflow_dispatch')),
    'expected to find at least one manually dispatchable workflow to scan',
  );
});
