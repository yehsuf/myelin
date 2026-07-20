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

    assert.ok(initSource.includes('managed.caBundlePath'), 'should use managed.caBundlePath');
    assert.ok(!initSource.includes("join(homedir(), '.myelin', 'ca-bundle.pem')"), 'should not hardcode path');
  });
});

describe('noProxyEnv managed PATH precedence', () => {
  it('prepends managed component bin dirs so Python 3.12 venvs win over system uv-tool installs', () => {
    const initSource = readFileSync(fileURLToPath(new URL('../src/cli/init.mjs', import.meta.url)), 'utf8');

    assert.ok(initSource.includes("join(componentsRoot, name, 'current', scriptsDir)"), 'should compute managed bin dir per component');
    assert.ok(initSource.includes('.split(sep).includes(binDir)'), 'should use exact-entry PATH dedup guard');
    assert.ok(initSource.includes("env[pathKey] ? binDir + sep + env[pathKey] : binDir"), 'should write to case-resolved PATH key, not append trailing separator');
  });

  it('resolves PATH key case-insensitively to avoid Windows Path/PATH collision', () => {
    const initSource = readFileSync(fileURLToPath(new URL('../src/cli/init.mjs', import.meta.url)), 'utf8');

    assert.ok(initSource.includes("Object.keys(env).find(k => k.toLowerCase() === 'path')"), 'should find existing PATH key case-insensitively');
    assert.ok(initSource.includes("env[pathKey]"), 'should read/write via resolved pathKey not hardcoded env.PATH');
    assert.ok(!initSource.includes("env.PATH"), 'should not use hardcoded env.PATH after the pathKey resolution');
  });

  it('includes semble and serena (Python uv components invoked by myelin init), not agentcairn', () => {
    const initSource = readFileSync(fileURLToPath(new URL('../src/cli/init.mjs', import.meta.url)), 'utf8');

    assert.ok(initSource.includes("'semble'"), 'semble must be in the PATH prepend list');
    assert.ok(initSource.includes("'serena'"), 'serena must be in the PATH prepend list (invoked via spawnAsync)');
    assert.ok(!initSource.match(/'agentcairn'/), 'agentcairn must NOT be in the list (not invoked by init, bin=cairn)');
  });
});
