import { spawnSync } from 'node:child_process';
import test from 'node:test';
import assert from 'node:assert/strict';

const SCRIPT = new URL('../src/update/verify-stable-version.mjs', import.meta.url).pathname;

function verify(version) {
  return spawnSync(process.execPath, [SCRIPT, version], { encoding: 'utf8' });
}

test('accepts exactly the version formats stable release discovery accepts', () => {
  for (const version of ['1.2.3', '0.0.1', '10.20.30', '1.2.3+build.5']) {
    const result = verify(version);
    assert.equal(result.status, 0, `expected ${version} to be accepted: ${result.stderr}`);
  }
});

test('rejects a leading "v" so the workflow input matches the tag-less version stable discovery stores', () => {
  const result = verify('v1.2.3');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /not an accepted stable release version/);
});

test('rejects prerelease versions, which stable discovery excludes', () => {
  const result = verify('1.2.3-alpha');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /not an accepted stable release version/);
});

test('rejects malformed versions such as leading zeros or missing components', () => {
  for (const version of ['01.2.3', '1.2', '1.2.3.4', 'not-a-version']) {
    const result = verify(version);
    assert.notEqual(result.status, 0, `expected ${version} to be rejected`);
  }
});
