import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { buildServiceEnginePlan } from '../src/config/engine-runtime.mjs';

describe('buildServiceEnginePlan', () => {
  it('keeps Python headroom as the managed engine when selected', () => {
    const plan = buildServiceEnginePlan({
      proxy: {
        engine: 'headroom',
        headroom: { port: 8787 },
        headroom_lite: { port: 8790 },
      },
    });

    assert.deepEqual(plan, {
      selectedEngine: 'headroom',
      selectedPort: 8787,
      headroomPort: 8787,
      headroomLitePort: 8790,
      shouldRunManagedHeadroom: true,
      shouldRemoveManagedHeadroom: false,
    });
  });

  it('switches mitm traffic to headroom-lite and removes managed headroom when selected', () => {
    const plan = buildServiceEnginePlan({
      proxy: {
        engine: 'headroom_lite',
        headroom: { port: 8787 },
        headroom_lite: { port: 8790 },
      },
    });

    assert.deepEqual(plan, {
      selectedEngine: 'headroom_lite',
      selectedPort: 8790,
      headroomPort: 8787,
      headroomLitePort: 8790,
      shouldRunManagedHeadroom: false,
      shouldRemoveManagedHeadroom: true,
    });
  });
});
