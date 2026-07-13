import { readFileSync } from 'node:fs';
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

describe('package test scripts', () => {
  it('uses a Node runner to discover test files without shell globs', () => {
    assert.equal(packageJson.scripts.test, 'node scripts/run-tests.mjs');
    assert.equal(packageJson.scripts['test:watch'], 'node scripts/run-tests.mjs --watch');
  });
});
