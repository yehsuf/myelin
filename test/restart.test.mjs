import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { buildCopilotHeadroomTaskEnv } from '../src/cli/restart.mjs';

describe('buildCopilotHeadroomTaskEnv', () => {
  it('points Copilot-Headroom at the local mitm egress listener', () => {
    const env = buildCopilotHeadroomTaskEnv({
      home: '/Users/alice',
      copilotPort: 8788,
      egressPort: 8889,
      mode: 'cache',
    });

    assert.equal(env.ANTHROPIC_TARGET_API_URL, 'http://127.0.0.1:8889');
    assert.equal(env.OPENAI_TARGET_API_URL, 'http://127.0.0.1:8889');
    assert.equal(env.HEADROOM_MODE, 'cache');
    assert.equal(env.NO_PROXY, '127.0.0.1,localhost,::1');
    assert.match(env.HEADROOM_WORKSPACE_DIR, /[\\/]Users[\\/]alice[\\/]\.myelin[\\/]headroom-copilot-8788$/);
  });
});
