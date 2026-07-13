import { strict as assert } from 'node:assert';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { testArgs } from '../scripts/run-tests.mjs';

describe('testArgs', () => {
  it('passes only recursive .test.mjs files as relative paths', () => {
    const root = mkdtempSync(join(process.cwd(), '.run-tests-fixture-'));
    try {
      mkdirSync(join(root, 'nested'));
      writeFileSync(join(root, 'nested', 'included.test.mjs'), '');
      writeFileSync(join(root, 'ignored.mjs'), '');
      assert.deepEqual(
        testArgs({ directory: root, cwd: root, nodeArgs: ['--watch'] }),
        ['--test', '--watch', join('nested', 'included.test.mjs')],
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not fall back to Node test discovery when no test files exist', () => {
    const root = mkdtempSync(join(process.cwd(), '.run-tests-fixture-'));
    try {
      assert.equal(testArgs({ directory: root, cwd: root }), null);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
