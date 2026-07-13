# Selected Engine, Two-Instance Proxy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the optional Copilot proxy a second isolated instance of the globally selected compression engine, without ever mixing Python Headroom and Headroom Lite.

**Architecture:** Normalize `proxy.engine` once, then derive immutable `primary` and optional `copilot` instance descriptors. Installer, restart, services, watchdogs, verify, stats, and MITM wiring consume those descriptors rather than Python-specific Copilot helpers. MITM retains exclusive real Copilot-provider egress through its loopback egress listener.

**Tech Stack:** Node.js >=20, ESM, `node:test`, Python mitmproxy addon, launchd, systemd user units, Windows registry Run key and WinSW.

## Global Constraints

- `proxy.engine` is exactly one of `headroom` or `headroom_lite`.
- Python Headroom and Headroom Lite never run, install, probe, restart, or revive together.
- An enabled Copilot role is a second instance of the selected engine, never a Python-specific exception.
- Primary and Copilot role state, workspace, logs, telemetry, and ports remain isolated.
- MITM is the sole real Copilot-provider egress owner; engines target only its loopback egress port.
- All management endpoints bind to `127.0.0.1`.
- Preserve macOS, Windows, and Linux behavior; Windows is the highest-priority Copilot platform.
- Never kill or reconfigure a process that cannot be proved Myelin-owned.
- No runtime dependency may be added to the proxy/compression path.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/config/engine-runtime.mjs` | Derive validated engine-role instance descriptors. |
| `src/config/schema.mjs`, `src/config/reader.mjs` | Preserve single-engine normalization and legacy migration. |
| `src/install.mjs` | Install selected primary and optional selected Copilot services. |
| `src/cli/restart.mjs` | Stop obsolete owned role services and restart selected descriptors. |
| `src/service/index.mjs` | Dispatch a generic selected-engine descriptor to platform adapters. |
| `src/service/launchd.mjs`, `src/service/systemd.mjs`, `src/service/windows.mjs` | Generate, inspect, and stop role-aware service definitions. |
| `src/cli/verify.mjs`, `src/cli/stats.mjs` | Report only resolved selected role instances. |
| `src/mitm/copilot_addon.py` | Keep destination restoration and select the configured Copilot loopback target only. |
| `docs/copilot-headroom-architecture.md` | Explain selected-engine, two-instance routing. |
| `test/{engine-runtime,install,restart,verify,service}.test.mjs` | Engine-role lifecycle coverage. |
| `test/test_mitm_forwarding.py` | Preserve loopback egress invariant for both selected engines. |

### Task 1: Model selected-engine instances

**Files:**
- Modify: `src/config/engine-runtime.mjs`
- Modify: `test/engine-runtime.test.mjs`

**Interfaces:**
- Produces `buildEngineInstancePlan(config)` returning `{ engine, instances }`.
- Each instance is `{ engine, role, port, id, stateDir, logPath, healthUrl, env }`.
- `instances` always has `primary`; it adds `copilot` only when
  `proxy.copilot_headroom.enabled === true`.

- [ ] **Step 1: Write failing descriptor tests**

```js
it('creates two Lite descriptors without a Python service', () => {
  const plan = buildEngineInstancePlan({
    proxy: {
      engine: 'headroom_lite',
      headroom_lite: { port: 8790 },
      copilot_headroom: { enabled: true, port: 8788 },
      mitm: { egress_port: 8889 },
    },
  });
  assert.deepEqual(plan.instances.map(({ engine, role, port }) => ({ engine, role, port })), [
    { engine: 'headroom_lite', role: 'primary', port: 8790 },
    { engine: 'headroom_lite', role: 'copilot', port: 8788 },
  ]);
  assert.deepEqual(plan.instances[1].env, {
    HEADROOM_LITE_UPSTREAM: 'http://127.0.0.1:8889',
    HEADROOM_LITE_COMPRESS_PROXY: 'true',
  });
});
```

- [ ] **Step 2: Run the focused test**

Run: `node --test test/engine-runtime.test.mjs`

Expected: FAIL because `buildEngineInstancePlan` does not exist.

- [ ] **Step 3: Implement descriptors**

```js
export function buildEngineInstancePlan(config = {}) {
  const engine = selectedEngine(config);
  const primaryPort = selectedEnginePort(config);
  const copilot = config.proxy?.copilot_headroom ?? {};
  const instances = [buildEngineInstance({ engine, role: 'primary', port: primaryPort, config })];
  if (copilot.enabled === true) {
    instances.push(buildEngineInstance({
      engine, role: 'copilot', port: copilot.port ?? 8788, config,
    }));
  }
  return { engine, instances };
}
```

Define `buildEngineInstance` in the same module. For a Lite Copilot role, set
`HEADROOM_LITE_UPSTREAM` to the MITM egress loopback URL and
`HEADROOM_LITE_COMPRESS_PROXY` to `'true'`; this invokes Lite's compressed
proxy path rather than transparent passthrough. For every engine, set only the
loopback egress environment it needs; do not include a real Copilot provider
URL. Give each role unique IDs and state paths.

- [ ] **Step 4: Run focused tests**

Run: `node --test test/engine-runtime.test.mjs`

Expected: PASS for Python/Lite, disabled/enabled Copilot, and unique role
identity cases.

- [ ] **Step 5: Commit**

```bash
git add src/config/engine-runtime.mjs test/engine-runtime.test.mjs
git commit -m "feat: model selected engine instances"
```

### Task 2: Make service adapters role- and engine-aware

**Files:**
- Modify: `src/service/index.mjs`
- Modify: `src/service/launchd.mjs`
- Modify: `src/service/systemd.mjs`
- Modify: `src/service/windows.mjs`
- Modify: `test/service.test.mjs`

**Interfaces:**
- Consumes an engine instance descriptor from Task 1.
- Produces `installEngineInstance(instance, platformOptions)`,
  `engineInstanceStatus(instance, platformOptions)`, and
  `removeEngineInstance(instance, platformOptions)`.

- [ ] **Step 1: Write failing generated-service tests**

```js
it('generates a Lite Copilot service with isolated state and MITM loopback upstream', () => {
  const unit = generateEngineInstanceUnit({
    engine: 'headroom_lite', role: 'copilot', port: 8788,
    stateDir: '/home/me/.myelin/headroom-lite-copilot',
    env: { HEADROOM_LITE_UPSTREAM_URL: 'http://127.0.0.1:8889' },
  });
  assert.match(unit, /headroom-lite/);
  assert.match(unit, /8788/);
  assert.match(unit, /127\.0\.0\.1:8889/);
  assert.doesNotMatch(unit, /\bheadroom proxy\b/);
});
```

- [ ] **Step 2: Run the focused tests**

Run: `node --test test/service.test.mjs`

Expected: FAIL because the platform adapters expose only
`installCopilotHeadroomService`.

- [ ] **Step 3: Replace Python-specific Copilot APIs**

```js
export async function installEngineInstance(instance, options) {
  return instance.engine === 'headroom_lite'
    ? installHeadroomLiteInstance(instance, options)
    : installPythonHeadroomInstance(instance, options);
}
```

Use `instance.role` only to select stable Myelin service IDs, workspace/state
directories, log paths, and health URLs. Use `instance.engine` only to select
the executable/arguments. Retain compatibility wrappers temporarily only if
they delegate to the generic API; no wrapper may hard-code Python behavior.

- [ ] **Step 4: Run platform generation tests**

Run: `node --test test/service.test.mjs`

Expected: PASS for primary/Copilot roles of both engines on launchd, systemd,
registry, and WinSW.

- [ ] **Step 5: Commit**

```bash
git add src/service test/service.test.mjs
git commit -m "refactor: generate services from engine instances"
```

### Task 3: Install only selected role instances

**Files:**
- Modify: `src/install.mjs`
- Modify: `test/install.test.mjs`

**Interfaces:**
- Consumes `buildEngineInstancePlan(cfg)`.
- Produces `applyServiceEngineInstallPlan` that installs every selected
  descriptor and removes only old Myelin-owned descriptors for the other engine.

- [ ] **Step 1: Write failing Lite-with-Copilot tests**

```js
it('installs Lite primary and Lite Copilot without probing Python Headroom', async () => {
  const calls = [];
  await applyServiceEngineInstallPlan({
    cfg: liteCopilotConfig,
    installEngineInstanceImpl: async (instance) => calls.push(instance),
    ensureManagedHeadroomServiceImpl: () => assert.fail('Python must not run'),
  });
  assert.deepEqual(calls.map(({ engine, role }) => `${engine}:${role}`), [
    'headroom_lite:primary', 'headroom_lite:copilot',
  ]);
});
```

- [ ] **Step 2: Run the focused test**

Run: `node --test test/install.test.mjs`

Expected: FAIL because the current Copilot installer always requests
`headroomBin`.

- [ ] **Step 3: Install the plan**

```js
const plan = buildEngineInstancePlan(cfg);
await removeObsoleteOwnedInstances({
  selectedEngine: plan.engine, os, cfg, winManager, home, warn: warnFn,
});
for (const instance of plan.instances) {
  await installEngineInstance(instance, platformOptions);
}
```

Resolve the Python binary only when `plan.engine === 'headroom'`; detect the
Lite binary only when `plan.engine === 'headroom_lite'`. On Lite failure,
surface the Lite failure and leave Python disabled.

- [ ] **Step 4: Run focused tests**

Run: `node --test test/install.test.mjs`

Expected: PASS for both engine matrices, stale owned registration cleanup, and
no Python fallback.

- [ ] **Step 5: Commit**

```bash
git add src/install.mjs test/install.test.mjs
git commit -m "fix: install selected engine for both proxy roles"
```

### Task 4: Restart and watchdog resolved descriptors safely

**Files:**
- Modify: `src/cli/restart.mjs`
- Modify: `src/service/windows.mjs`
- Modify: `test/restart.test.mjs`

**Interfaces:**
- `runRestart()` consumes the Task 1 plan.
- `restartEngineInstance(instance, options)` waits for that descriptor's
  `healthUrl`.

- [ ] **Step 1: Write failing restart-order tests**

```js
it('restarts the selected Lite Copilot instance before MITM without Python fallback', async () => {
  const order = [];
  await runRestart({
    config: liteCopilotConfig,
    restartEngineInstanceImpl: async ({ role }) => order.push(role),
    restartMitmImpl: async () => order.push('mitm'),
    restartManagedHeadroomImpl: () => assert.fail('Python must not restart'),
  });
  assert.deepEqual(order, ['primary', 'copilot', 'mitm']);
});
```

- [ ] **Step 2: Run the focused test**

Run: `node --test test/restart.test.mjs`

Expected: FAIL because `defaultRestartCopilotHeadroom` starts Python Headroom.

- [ ] **Step 3: Replace the special-case restart path**

```js
const plan = buildEngineInstancePlan(cfg);
await stopObsoleteOwnedInstances({
  selectedEngine: plan.engine, os, cfg, winManager, home, warn,
});
for (const instance of plan.instances) {
  await restartEngineInstance(instance, { os, cfg, winManager, log, warn });
}
await restartMitmImpl({ os, cfg, winManager, log, warn });
```

Generate Windows registry and WinSW watchdog identities from `instance.id`;
validate launcher executable, port, and role-specific state path before
stopping a process. Do not use a generic `headroom.exe` process match.

- [ ] **Step 4: Run focused tests**

Run: `node --test test/restart.test.mjs`

Expected: PASS for both engines, two roles, Windows registry/WinSW transitions,
and Lite failure without Python revival.

- [ ] **Step 5: Commit**

```bash
git add src/cli/restart.mjs src/service/windows.mjs test/restart.test.mjs
git commit -m "fix: restart selected engine instances"
```

### Task 5: Report resolved components and preserve MITM routing

**Files:**
- Modify: `src/cli/verify.mjs`
- Modify: `src/cli/stats.mjs`
- Modify: `src/mitm/copilot_addon.py`
- Modify: `test/verify.test.mjs`
- Modify: `test/stats.test.mjs`
- Modify: `test/test_mitm_forwarding.py`

**Interfaces:**
- Verify and stats consume `buildEngineInstancePlan(config).instances`.
- MITM receives one local `COPILOT_ENGINE_URL` derived from the enabled
  selected Copilot descriptor.

- [ ] **Step 1: Write failing visibility and forwarding tests**

```js
it('shows Lite primary and Lite Copilot rows, never Python Headroom', async () => {
  const results = await buildVerifyResults({ config: liteCopilotConfig, fetchImpl });
  assert.deepEqual(results.filter(({ name }) => /headroom/i.test(name)).map(({ name }) => name), [
    'Headroom Lite service', 'Headroom Lite health',
    'Copilot Headroom Lite service', 'Copilot Headroom Lite health',
  ]);
});
```

```python
def test_selected_engine_loopback_restores_original_destination():
    flow = _make_egress_flow('127.0.0.1', '/v1/chat/completions')
    flow.request.port = 8889
    flow.request.scheme = 'http'
    flow.request.headers['x-myelin-original-scheme'] = 'https'
    flow.request.headers['x-myelin-original-host'] = 'api.githubcopilot.com'
    flow.request.headers['x-myelin-original-port'] = '443'
    flow.request.headers['x-myelin-original-path'] = '/chat/completions'
    old_egress = copilot_addon.EGRESS_PORT
    try:
        copilot_addon.EGRESS_PORT = 8889
        MyelinAddon().request(flow)
    finally:
        copilot_addon.EGRESS_PORT = old_egress
    assert (flow.request.host, flow.request.port, flow.request.scheme) == (
        'api.githubcopilot.com', 443, 'https',
    )
    assert 'x-myelin-original-host' not in flow.request.headers
```

- [ ] **Step 2: Run focused tests**

Run: `node --test test/verify.test.mjs test/stats.test.mjs && python3 -m pytest test/test_mitm_forwarding.py -q`

Expected: FAIL because current status labels and lifecycle are Python-specific.

- [ ] **Step 3: Implement descriptor-driven probes**

```js
for (const instance of buildEngineInstancePlan(config).instances) {
  results.push(await probeEngineInstance(instance, { fetchImpl, serviceStatusImpl }));
}
```

MITM must reject an egress request without its private original-destination
headers and restore the destination only at egress. The addon must not inspect
`proxy.engine` or select a provider URL; service wiring supplies the local
selected-engine Copilot URL.

- [ ] **Step 4: Run focused tests**

Run: `node --test test/verify.test.mjs test/stats.test.mjs && python3 -m pytest test/test_mitm_forwarding.py -q`

Expected: PASS for selected-only reporting and Python/Lite loopback routing.

- [ ] **Step 5: Commit**

```bash
git add src/cli/verify.mjs src/cli/stats.mjs src/mitm/copilot_addon.py test
git commit -m "fix: report selected Copilot engine instances"
```

### Task 6: Document and validate the complete matrix

**Files:**
- Modify: `docs/copilot-headroom-architecture.md`
- Modify: `docs/settings-reference.md`
- Modify: `README.md`
- Modify: `docs/superpowers/specs/2026-07-13-selected-engine-two-instance-design.md`

- [ ] **Step 1: Document the engine matrix**

Document the two roles, selected-engine matrix, loopback-only MITM egress
flow, no-fallback behavior, management endpoint distinction, migration rules,
and platform-specific service identities. Remove every claim that
`copilot_headroom` means Python Headroom.

- [ ] **Step 2: Run Node tests**

Run: `node --test test/config.test.mjs test/engine-runtime.test.mjs test/install.test.mjs test/restart.test.mjs test/verify.test.mjs test/stats.test.mjs test/service.test.mjs`

Expected: PASS.

- [ ] **Step 3: Run MITM tests**

Run: `python3 -m pytest test/test_mitm_forwarding.py -q`

Expected: PASS.

- [ ] **Step 4: Run the full suite**

Run: `npm test`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add README.md docs
git commit -m "docs: clarify selected engine Copilot routing"
```

## Self-Review

- Spec coverage: Tasks 1-4 replace the Python-specific lifecycle with
  selected-engine descriptors for both roles; Task 5 protects selected-only
  observability and MITM-only egress; Task 6 documents and validates all
  supported platforms.
- No-fallback coverage: Tasks 3 and 4 explicitly make missing or failed Lite
  an error without starting Python.
- Type consistency: all lifecycle surfaces use the same descriptor fields
  defined by Task 1.
