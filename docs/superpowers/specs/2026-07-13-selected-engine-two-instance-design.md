# Selected Engine, Two-Instance Proxy Design

## Decision

`proxy.engine` is the sole selector for Myelin's compression backend. Its
allowed values are `headroom` (Python Headroom) and `headroom_lite` (Node
Headroom Lite). The non-selected engine is absent from installation, service
generation, restart, watchdog, verification, and telemetry paths.

When `proxy.copilot_headroom.enabled` is false, Myelin has one selected-engine
instance: the primary instance used by `_claude`. When enabled, Myelin has two
instances of the *same* selected engine:

| Role | Consumer | Port | State |
|---|---|---:|---|
| `primary` | `_claude` | selected engine's primary configured port | Isolated Claude cache, workspace, and telemetry |
| `copilot` | `_copilot` through MITM | `proxy.copilot_headroom.port` | Isolated Copilot cache, workspace, and telemetry |

The two instances are required because cache, transform, workspace, and
telemetry state must not cross between Claude and Copilot. They do not imply a
mixed-engine deployment.

## Required routing

```text
_claude  -> selected engine (primary) -> configured Claude upstream

_copilot -> MITM ingress (:8888)
         -> selected engine (copilot instance, :8788)
         -> MITM egress (:8889)
         -> original Copilot API destination
```

MITM is the only component that can make real Copilot-provider egress. At
ingress it stores the original destination in private loopback headers. At
egress it validates and restores that destination. The selected engine points
only to `http://127.0.0.1:<egress_port>` and never receives a configured
Copilot provider URL.

## Engine matrix

| Selected `proxy.engine` | Primary service | Optional Copilot service | Forbidden |
|---|---|---|---|
| `headroom` | Python Headroom at `proxy.headroom.port` | Python Headroom at `proxy.copilot_headroom.port` | Headroom Lite install/start/probe/watchdog |
| `headroom_lite` | Headroom Lite at `proxy.headroom_lite.port` | Headroom Lite at `proxy.copilot_headroom.port` | Python Headroom install/start/probe/watchdog/fallback |

The Copilot instance has an explicit role-specific service identity,
workspace/state directory, log path, health URL, and telemetry component name.
For example, neither platform service naming nor process ownership checks may
assume that the `copilot` role means Python Headroom.

## Configuration and migration

```yaml
proxy:
  engine: headroom_lite # exactly one of: headroom, headroom_lite
  headroom:
    port: 8787
  headroom_lite:
    port: 8790
  copilot_headroom:
    enabled: true
    port: 8788
  mitm:
    port: 8888
    egress_port: 8889
```

`proxy.copilot_headroom` configures the optional `copilot` *role*, not an
engine. `mode` remains an engine-specific Python Headroom setting and must not
be passed to Lite. Existing configurations without `proxy.engine` retain the
current deterministic legacy migration: explicit legacy Lite enablement selects
Lite; otherwise Headroom is selected. Conflicting legacy flags warn and select
Headroom. A migration must never start both engines to infer user intent.

## Lifecycle requirements

1. Resolve `engine` once from normalized config, then build an ordered instance
   list: primary selected instance plus optional Copilot selected instance.
2. Before installing or restarting selected instances, remove only
   Myelin-owned registrations and processes belonging to the other engine for
   both roles. Never kill an arbitrary executable merely because it owns a
   matching port.
3. Generate all three platform service definitions from the same instance
   descriptor. The descriptor supplies engine, role, port, service ID,
   working/state directory, log path, command, environment, and health URL.
4. In Lite mode, a missing or unhealthy Lite binary is an explicit Lite error;
   it must not revive or fall back to Python Headroom.
5. MITM is restarted only after the selected Copilot instance is registered
   when the Copilot role is enabled. It receives the selected Copilot loopback
   target through scoped service configuration.
6. Watchdogs cover only the selected role instances and MITM. A disabled
   Copilot role has no service, probe, watchdog task, or status row.

## Observability requirements

The observer inventory is derived from the resolved descriptors:

- `headroom` or `headroom_lite` represents the selected primary instance.
- `copilot-headroom` or `copilot-headroom-lite` represents the enabled
  selected Copilot instance.
- MITM reports separately.

Verification must show only selected and enabled components. A selected
component without a compatible endpoint is unhealthy or degraded, never
silently omitted and never represented as a zero-value component. Metrics
remain aggregate-only and must not persist prompts, responses, authorization
headers, filesystem paths, or user identifiers.

## Non-goals

- This decision does not make Lite emulate Python-only transforms.
- It does not permit a Python fallback for Lite.
- It does not change MITM's original-destination restoration or allow an
  engine to choose a real provider URL.
- It does not merge Claude and Copilot state merely because they select the
  same backend.

## Acceptance scenarios

1. With `engine: headroom` and Copilot disabled, exactly one Python service is
   installed and verified; no Lite command, process, or status probe occurs.
2. With `engine: headroom` and Copilot enabled, Python primary and Python
   Copilot services run on distinct ports and isolated state paths; Copilot
   traffic follows the full MITM loopback route.
3. With `engine: headroom_lite` and Copilot disabled, exactly one Lite service
   is installed and verified; no Python package, process, registration,
   watchdog, or fallback is used.
4. With `engine: headroom_lite` and Copilot enabled, Lite primary and Lite
   Copilot services run on distinct ports and isolated state paths; the Copilot
   instance targets MITM egress rather than a provider URL.
5. Switching engines removes only Myelin-owned registrations for both old
   roles before starting the new selected roles, on macOS, Windows, and Linux.
