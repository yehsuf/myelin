import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
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
