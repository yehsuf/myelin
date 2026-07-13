# Copilot Selected-Engine Architecture

`proxy.copilot_headroom` enables an isolated Copilot instance of Myelin's
**selected** compression engine. It does not select Python Headroom.

## Engine and role model

`proxy.engine` selects exactly one backend:

| `proxy.engine` | Primary `_claude` instance | Optional `_copilot` instance |
|---|---|---|
| `headroom` | Python Headroom at `proxy.headroom.port` | Python Headroom at `proxy.copilot_headroom.port` |
| `headroom_lite` | Headroom Lite at `proxy.headroom_lite.port` | Headroom Lite at `proxy.copilot_headroom.port` |

The primary and Copilot instances have independent cache, workspace, log, and
telemetry state. Python Headroom and Headroom Lite are never mixed: the
non-selected engine is not installed, started, probed, watched, or used as a
fallback.

## Copilot data flow

```text
Copilot CLI
   |
   v
MITM ingress :8888
   | records original destination in private loopback headers
   v
selected-engine Copilot instance :8788
   | only targets http://127.0.0.1:<proxy.mitm.egress_port>
   v
MITM egress :8889
   | validates private headers and restores original destination
   v
Original Copilot API
```

MITM is the sole real-network-egress owner. Neither selected engine receives
or stores a Copilot provider URL. Requests lacking the private original
destination headers are rejected at the egress listener rather than forwarded.

## Configuration

```bash
myelin config set proxy.engine headroom_lite
myelin config set proxy.copilot_headroom.enabled true
myelin install
myelin verify
```

Relevant keys:

| Key | Default | Purpose |
|---|---:|---|
| `proxy.engine` | `headroom` | Selected backend: `headroom` or `headroom_lite` |
| `proxy.headroom.port` | `8787` | Python primary instance port |
| `proxy.headroom_lite.port` | `8790` | Lite primary instance port |
| `proxy.copilot_headroom.enabled` | `false` | Enables the selected-engine Copilot role |
| `proxy.copilot_headroom.port` | `8788` | Selected-engine Copilot instance port |
| `proxy.mitm.port` | `8888` | MITM ingress listener |
| `proxy.mitm.egress_port` | `8889` | MITM loopback egress listener |

When Lite is selected, a missing Lite binary is reported as a Lite error.
Myelin does not install or start Python Headroom as a substitute.

## Lifecycle and verification

Myelin derives service registrations, watchdogs, health checks, and status
rows from the resolved engine-role instances. With Copilot disabled, no
Copilot service or probe exists. With it enabled, `myelin verify` reports only
the selected primary and selected Copilot components, plus MITM.

On an engine change, Myelin removes only registrations and processes it can
prove it owns for the old engine's primary and Copilot roles, then starts the
new selected roles. It must never kill arbitrary `headroom`, `headroom-lite`,
or `mitmdump` processes by name or port alone.
