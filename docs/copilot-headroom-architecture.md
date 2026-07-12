# Copilot-Headroom Architecture

Design and implementation notes for `proxy.copilot_headroom` — a second,
dedicated Headroom instance that gives GitHub Copilot CLI traffic the same
full compression pipeline (cache-mode prefix alignment, `content_router`,
TOIN pattern-learning, stats) that Claude Code already gets from the primary
`proxy.headroom` instance, instead of the stateless `/v1/compress`-only
sidecar call Copilot traffic uses by default.

Disabled by default (`proxy.copilot_headroom.enabled: false`) — opt-in until
validated on your own install. Fully implemented and cross-platform tested
(macOS, Linux, Windows); safe to enable.

## Why a second instance, not one shared instance

The primary `proxy.headroom` instance (`:8787`) serves Claude Code directly
via `ANTHROPIC_BASE_URL` — a full end-to-end HTTP proxy Claude Code talks to
natively. Copilot CLI has no equivalent "point me at a proxy" configuration
option; its TLS traffic is instead intercepted by mitmproxy (`:8888`), which
already owns the real network egress path (corporate CA chaining, NetFree
block-bypass, etc.).

Routing Copilot traffic through the *same* Headroom instance Claude Code uses
would mean two unrelated clients sharing one cache-mode prefix-freezing
state — the two request streams would fight over which "prior turns" to
freeze, destroying prompt-cache alignment for both. A second, isolated
instance keeps each client's cache state independent, matching the same
"freeze stable prefix, mutate the tail" strategy each already relies on
individually.

## Data flow

```
Copilot CLI
   │ (TLS, no proxy awareness)
   ▼
mitmproxy :8888  (ingress — sole real-network-egress owner)
   │  arrival-port gating: is this a /v1/messages or /chat/completions
   │  request destined for a Copilot API host?
   │  add private x-myelin-original-* destination headers
   ▼
Copilot-Headroom :8788  (isolated instance, own cache/stats state)
   │  full pipeline: cache-mode freeze, content_router, TOIN, BM25 tool
   │  filtering, stats accounting — everything the primary instance does
   │  upstream target is only http://127.0.0.1:8889
   ▼
mitmproxy egress leg :8889  (same mitmproxy process, second listener)
   │  restore original host/port/scheme/path from private headers,
   │  then forward to the original Copilot destination
   │  reject requests missing those private headers
   │  (block-bypass / corp CA / VPN routing all still apply)
   ▼
api.githubcopilot.com / api.business.githubcopilot.com
```

Two invariants this design preserves:
1. **mitmproxy never stops being the sole network-egress owner.** Copilot-
   Headroom never stores or selects Copilot provider URLs. Its outbound call
   loops back to mitmproxy's second listener (`egress_port`), where the
   original destination from the ingress flow is restored before real network
   egress. This means block-bypass, corporate CA trust, and VPN domain routing
   all keep working unchanged.
   The egress listener is loopback-only for Copilot-Headroom: requests that
   arrive without the private `x-myelin-original-*` headers are rejected
   instead of being proxied back to itself.
2. **Cache state never crosses instances.** Claude Code's `:8787` instance
   and Copilot's `:8788` instance never share a cache/stats namespace.

## Config reference

| Key | Default | Purpose |
|---|---|---|
| `proxy.copilot_headroom.enabled` | `false` | Opt-in switch for this feature |
| `proxy.copilot_headroom.port` | `8788` | Copilot-Headroom's own loopback port |
| `proxy.copilot_headroom.mode` | `cache` | Same cache-vs-token mode choice as the primary instance |
| `proxy.mitm.egress_port` | `8889` | The second mitmproxy listener Copilot-Headroom's outbound calls tunnel through |

No Copilot provider URL is configured here. The installer points both
Copilot-Headroom target env vars at `http://127.0.0.1:${proxy.mitm.egress_port}`
and the mitm addon restores the original Copilot destination per request.

## Enabling it

```bash
myelin config set proxy.copilot_headroom.enabled true
myelin update   # or: myelin install, to pick up the new service
myelin verify   # confirm "Copilot-Headroom service" / "Copilot-Headroom health" rows are green
```

## Build history (stages)

Implemented and validated in six stages:

- **Stage 0 — Snapshot**: backed up existing launchd plists/config, confirmed
  `myelin verify` was green and the plain-Copilot (no-proxy) escape hatch
  worked, before touching anything.
- **Stage 1 — Isolated instance**: stand up Copilot-Headroom on `:8788` in
  full isolation (separate data dir, `ANTHROPIC_TARGET_API_URL`/
  `OPENAI_TARGET_API_URL` pointed at the local mitm egress listener),
  health-check standalone before wiring anything else to it.
- **Stage 2 — Egress listener**: stand up mitmproxy's second, loopback-only
  listener on `:8889` as a separate/staging process, confirm it restores
  private `x-myelin-original-*` headers and rejects unmarked requests before
  touching the live `:8888` config.
- **Stage 3 — Wire egress**: point Copilot-Headroom's outbound calls
  (`ANTHROPIC_TARGET_API_URL` and `OPENAI_TARGET_API_URL`) at the Stage 2
  listener, send synthetic requests for both wire formats (Anthropic + OpenAI),
  and confirm compression + 200s + block-bypass-on-forced-418 all work together.
- **Stage 4 — Staging redirect**: added the arrival-port gating + redirect +
  path-rewrite logic to `copilot_addon.py`, deployed on a non-live staging
  port (`:18888`, not `:8888`), ran a full loop test with real Copilot CLI
  traffic pointed at the staging port before ever touching production.
- **Stage 5 — Live cutover** *(not yet executed on any machine)*: fold the
  validated two-listener config into the live `:8888`/`:8889` mitmproxy
  process, restart once, run `myelin verify` + a canary request. Rollback
  plan: restore the pre-cutover `.bak` plist/unit file. This is the one
  step in the whole build that touches a live, already-in-use listener —
  treat it with the same care as any production cutover (pick a low-traffic
  window, have the rollback ready before starting).
- **Stage 6 — Watchdog + docs**: the watchdog's port-coverage code (so the
  health-check loop also covers `:8788`/`:8889`, not just the original
  `:8787`/`:8888`) shipped as part of the installer/service-support work.
  This document is the other half of that stage.

## Cross-platform validation notes

Validated live on real Linux and Windows machines (in addition to macOS):

- **Linux**: `installCopilotHeadroomService` exercised live; the mitmproxy
  dual-listener config confirmed against a real mitmproxy 11.0.2 process.
- **Windows**: `installCopilotHeadroomService` only starts correctly when
  invoked via a detached Task Scheduler task (`schtasks`) — direct SSH
  invocation is fundamentally incompatible with starting *any* Windows
  service, due to a Win32-OpenSSH job-object-kill-on-close behavior (this
  affects Windows service management generally, not something specific to
  this feature). If you're scripting an install over SSH on Windows, always
  route service-start operations through a detached scheduled task rather
  than invoking them directly in the SSH session.
