import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { getInitToolIds } from '../src/cli/init.mjs';

describe('getInitToolIds', () => {
  it('omits codegraph when code_discovery.codegraph is false', () => {
    const toolIds = getInitToolIds({ code_discovery: { codegraph: false } });
    assert.equal(toolIds.includes('codegraph'), false);
  });

  it('includes codegraph when code_discovery.codegraph is true', () => {
    const toolIds = getInitToolIds({ code_discovery: { codegraph: true } });
    assert.equal(toolIds.includes('codegraph'), true);
  });
});

describe('init CA bundle path', () => {
  it('derives the CA bundle path from shared managed paths (honors MYELIN_DIR)', () => {
    const initSource = readFileSync(fileURLToPath(new URL('../src/cli/init.mjs', import.meta.url)), 'utf8');

    assert.ok(initSource.includes('managedPaths({ home: homedir() }).caBundlePath'));
    assert.ok(!initSource.includes("join(homedir(), '.myelin', 'ca-bundle.pem')"));
  });
});
