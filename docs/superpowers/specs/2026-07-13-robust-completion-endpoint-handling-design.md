# Robust completion-endpoint handling for the mitm thrash cache

**Date:** 2026-07-13
**Status:** approved (design)
**Area:** `src/mitm/copilot_addon.py` (mitmproxy addon)

## Problem

The thrash cache excludes LLM completion traffic by an **exact-path allowlist**
(`_COMPLETION_PATHS`: `/v1/messages`, `/chat/completions`, `/v1/chat/completions`,
and — as of the preceding commit — `/responses`, `/v1/responses`). When a provider
introduces a **new** completion endpoint, it is silently unrecognized, so its POST
bodies become thrash-cache-eligible. A stored `application/json` body can then be
served for a streaming (SSE) completion, reproducing the client error
`EOF while parsing a value at line 1 column 0` and a 5-retry loop.

GitHub Copilot's migration to the OpenAI **Responses API** (`POST /responses`,
`GET /responses/{id}`) is the concrete instance that motivated this: the addon did
not know the path, so `/responses` was cache-eligible (proven by a test that seeds
the cache under a `POST /responses` key and observes a stale JSON body being served).

The exact-path allowlist is fragile. We want the cache to be **robust to new
endpoints automatically**, and we want to **detect** new endpoints when they appear
so the recognized-path list (used for compression/format detection) can be updated.

## Goals

1. **Safety net:** any new completion endpoint on a known LLM provider host is
   automatically excluded from the thrash cache — no path-list entry required.
2. **Detection:** when an unrecognized streaming endpoint appears on a known LLM
   host, emit a one-time warning so the change is visible.

Non-goal: compressing the Responses API `input` schema (separate headroom-lite
feature; tracked as backlog).

## Design

### Safety net — defense-in-depth cache exclusion

Three new **pure** helpers:

- `_is_llm_host(host) -> bool` — True if `host` matches any pattern in
  `_DOMAIN_PATTERNS` (the known LLM providers: `*.githubcopilot.com`,
  `api.anthropic.com`, `api.openai.com`, `*.openai.azure.com`).
- `_body_looks_like_completion(body: bytes) -> bool` — best-effort JSON parse;
  True if the top-level object contains any completion marker key:
  `messages`, `input`, `prompt`, `contents`, `instructions`. Guarded: empty,
  oversized (> a small cap, e.g. 2 MiB), or non-JSON bodies return False without
  raising.
- `_is_noncacheable_request(host, path, body) -> bool` —
  `_is_completion_path(host, path) or _is_llm_host(host) or _body_looks_like_completion(body)`.

Wiring:

- **Cache serve** (request hook, currently `if THRASH_CACHE and not _is_completion_path(host, path)`):
  change to `if THRASH_CACHE and not _is_noncacheable_request(host, path, flow.request.content or b'')`.
- **Cache store** (response hook, currently guarded by `not _is_completion_path(...)`
  and `not _is_streaming_response(...)`): add `and not _is_llm_host(host)`.

Ordering keeps it cheap: `_is_llm_host` short-circuits, so
`_body_looks_like_completion` only parses bodies for **non-LLM** hosts (rare).

Net effect: **every LLM-host POST and every completion-shaped body is excluded from
the cache**, regardless of path. The `_COMPLETION_PATHS` list remains, but only for
provider/format detection (compression) — no longer the sole cache-safety gate.

### Detection — surface unrecognized endpoints

- Module-level `_UNKNOWN_COMPLETION_ENDPOINTS: set[tuple[str, str]]`, deduped by
  `(host, normalized_path)` where `normalized_path` keeps the first one/two path
  segments (so `/responses/resp_abc123` normalizes to `/responses`).
- In the **response hook**, fire when ALL hold:
  - `_is_llm_host(host)`, and
  - `not _is_completion_path(host, path)`, and
  - `_is_streaming_response(flow.response)`.
- On the first sighting of a unique `(host, normalized_path)`: emit
  `[myelin] ⚠ unrecognized streaming endpoint {host}{path} — not in _COMPLETION_PATHS; caching auto-disabled (safe). Consider adding it.`
  via `ctx.log.warn`, then add to the set (logs once per process; no spam).

Log-based only (where these signals already surface) plus an in-memory set — no new
files or config. The safety net makes it *safe*; detection makes it *visible*.

## Components & boundaries

| Unit | Purpose | Depends on |
|------|---------|-----------|
| `_is_llm_host` | classify host as a known LLM provider | `_DOMAIN_PATTERNS` |
| `_body_looks_like_completion` | classify body as completion-shaped | stdlib json |
| `_is_noncacheable_request` | single cache-exclusion predicate | the two above + `_is_completion_path` |
| detection block | warn-once on unknown streaming endpoint | `_is_llm_host`, `_is_completion_path`, `_is_streaming_response` |

All helpers are pure and unit-testable in isolation (no mitmproxy types).

## Error handling

- `_body_looks_like_completion` never raises: parse/size failures → `False`
  (fail toward *not* treating it as completion, but the host rule already covers the
  common case; body-shape is the backstop for unknown hosts).
- Detection is best-effort; any exception in the warn-once path is swallowed so it
  can never affect request handling.

## Testing

Extend `test/test_thrash_cache_no_completions.py` (existing stub pattern):

- `_is_llm_host`: matches each `_DOMAIN_PATTERNS` host; rejects `example.com`.
- `_body_looks_like_completion`: True for `messages`/`input`/`prompt`/`contents`/
  `instructions`; False for `{"foo":1}`, empty, invalid, and oversized bodies.
- Serve-side: a POST to a known LLM host on a **brand-new unknown path**, with a
  pre-seeded cache, is not served (proves future endpoints are safe with no path
  entry).
- Store-side: a streaming response on an unknown LLM-host path is not stored.
- Detection: an unrecognized streaming endpoint logs once and is recorded in
  `_UNKNOWN_COMPLETION_ENDPOINTS`; a second identical request does not re-log.

Validation: full Python suite per-file (avoids the known cross-file
`copilot_addon` global-state leak), code review, rebase on latest `origin/main`
before PR.

## Integration

Built stacked on `fix/responses-completion-path` so one coherent PR delivers:
recognize `/responses` + generalize cache safety to all LLM hosts + detect unknown
endpoints. The `/responses` path entry remains valuable for format detection and
suppresses its own detection warning.
