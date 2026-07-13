#!/usr/bin/env python3
"""
Myelin mitmproxy addon — generic LLM compression & caching proxy.

Per-request pipeline:
  1. RAG inject    — code context when serena MCP absent (ripgrep/serena fallback)
  2. Tool filter   — BM25 + optional model2vec: removes irrelevant tools from tools[]
  3. Compress      — Headroom /v1/compress shrinks ALL message types
  4. Forward to provider — all headers (auth, cache_control) passed through untouched

Per-response:
  6. Block detection (HTTP 418 + configurable body marker) → VPN file → poll reachability → replay
  7. Log token savings

Adding a new provider: add an entry to PROVIDERS dict. No other changes needed.
Additional providers can be injected at runtime via MYELIN_EXTRA_PROVIDERS (JSON).

Standard env vars respected (all optional):
  HTTPS_PROXY / HTTP_PROXY / NO_PROXY   — forwarded to upstream
  SSL_CERT_FILE / REQUESTS_CA_BUNDLE    — used for Headroom /v1/compress calls

Myelin-specific env vars (all optional):
  MYELIN_HEADROOM_PORT      default: 8787
  MYELIN_COMPRESS            1/0
  MYELIN_CACHE_INJECT        1/0
  MYELIN_TOOL_FILTER         1/0
  MYELIN_RAG_INJECT          1/0 (default 0 — see rag_injector.py cache-stability note)
  MYELIN_VPN_DOMAINS_FILE    path to VPN routing file (feature disabled if unset)
  MYELIN_BLOCK_MARKER        body substring that confirms a network block page
  MYELIN_LOG_SAVINGS         1/0
  MYELIN_EXTRA_PROVIDERS     JSON object extending PROVIDERS (e.g. for private endpoints)
"""

# ---------------------------------------------------------------------------
# Path setup — must come before any local imports.
# mitmdump loads addon scripts as top-level modules (not packages),
# so relative imports fail. We add our own directory to sys.path.
# ---------------------------------------------------------------------------
import os
import sys
_ADDON_DIR = os.path.dirname(os.path.abspath(__file__))
if _ADDON_DIR not in sys.path:
    sys.path.insert(0, _ADDON_DIR)

import asyncio
import collections
import gzip
import hashlib
import http.client as http_client
import json
import logging
import re
import socket
import ssl
import struct
import subprocess
import time
import urllib.request
import urllib.error
from pathlib import Path
from typing import Optional
from urllib.parse import urlparse

from mitmproxy import ctx, http

from async_offload import GuardedPool, Rejected, submit_guarded

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Configuration — read from env vars, all optional
# ---------------------------------------------------------------------------

HEADROOM_PORT   = int(os.environ.get('MYELIN_HEADROOM_PORT', '8787'))
HEADROOM_BASE   = f'http://127.0.0.1:{HEADROOM_PORT}'
# 20s (up from an original hardcoded 8s): Headroom's own internal compression
# timeout (its primary Claude Code full-pipeline path) is 30s
# (proxy/helpers.py: COMPRESSION_TIMEOUT_SECONDS = 30.0) — 8s was tight
# relative to that precedent and caused intermittent "compression error:
# timed out" fallbacks on larger payloads. Configurable since Copilot CLI's
# own client-side HTTP timeout tolerance isn't confirmed from this codebase;
# raise further only after checking it doesn't stack badly with that.
HEADROOM_COMPRESS_TIMEOUT_SECONDS = float(os.environ.get('MYELIN_HEADROOM_COMPRESS_TIMEOUT', '20'))

COMPRESS     = os.environ.get('MYELIN_COMPRESS',    '1') == '1'
TOOL_FILTER  = os.environ.get('MYELIN_TOOL_FILTER', '1') == '1'
# Default OFF (was '1'): the injector prepends a synthetic assistant block
# before the last user turn, which is not persisted client-side — every
# subsequent turn's cache-write diverges right after the prior turn,
# forfeiting the reusable prefix on every injected request. Only re-enable
# once the injection point is reworked to be cache-stable (e.g. system-tail
# placement instead of mid-history). See docs/settings-reference.md.
RAG_INJECT   = os.environ.get('MYELIN_RAG_INJECT',  '0') == '1'
# Request-side Serena code context injection (SSE-safe: never touches
# responses, never mutates tools[] or frozen prompt-cache prefix).
# See src/mitm/serena_context.py for full invariants and env vars.
SERENA_CONTEXT = os.environ.get('MYELIN_SERENA_CONTEXT', '0') == '1'
THRASH_CACHE = os.environ.get('MYELIN_THRASH_CACHE', '1') == '1'
LOG_SAVINGS  = os.environ.get('MYELIN_LOG_SAVINGS', '1') == '1'

# ---------------------------------------------------------------------------
# Offload pools (see async_offload.py).
#
# mitmproxy runs sync hooks on its single event loop; blocking I/O there freezes
# the whole proxy. The blocking compress call and the SOCKS5 block-bypass relay
# are pushed onto DEDICATED thread pools (never asyncio's default executor,
# which is shared with DNS getaddrinfo — a burst of slow relays there would
# starve new CONNECTs and re-create the stall). Two pools so slow 15s relays
# can't head-of-line-block fast 2s compress calls. Both are lazily created.
# ---------------------------------------------------------------------------

def _int_env(name: str, default: int, lo: int = 1, hi: int = 64) -> int:
    try:
        v = int(os.environ.get(name, str(default)))
    except (TypeError, ValueError):
        v = default
    return max(lo, min(hi, v))

SOCKS_WORKERS    = _int_env('MYELIN_SOCKS_WORKERS', 16, 1, 64)
COMPRESS_WORKERS = _int_env('MYELIN_COMPRESS_WORKERS', 4, 1, 32)

_SOCKS_POOL    = GuardedPool('socks', SOCKS_WORKERS, failure_threshold=3, cooldown=30.0)
_COMPRESS_POOL = GuardedPool('compress', COMPRESS_WORKERS, failure_threshold=3, cooldown=30.0)


# Block detection + override proxy routing (opt-in).
#
# When a network filter blocks an LLM host (returns 418), instead of writing
# to a domain file and waiting for a VPN daemon to poll, we directly re-route
# the replayed request through an override proxy (SOCKS5 or HTTP).
#
# Set MYELIN_OVERRIDE_PROXY to your VPN/SOCKS endpoint, e.g.:
#   socks5://10.8.0.1:1080
#   http://10.8.0.1:3128
#
# This maps to mitmproxy's server_conn.via field which switches the upstream
# transport for that specific flow — no global proxy change, no daemon needed.
#
# MYELIN_BLOCK_MARKER: body substring confirming a block page (optional).
# If unset, any 418 triggers the retry.

_OVERRIDE_PROXY_RAW = os.environ.get('MYELIN_OVERRIDE_PROXY', '')
OVERRIDE_PROXY: Optional[str] = _OVERRIDE_PROXY_RAW if _OVERRIDE_PROXY_RAW else None

BLOCK_BYPASS = os.environ.get('MYELIN_BLOCK_BYPASS', '0') == '1'

# Retry-After (seconds) advertised on the graceful 503 returned when a 418
# network block can't be recovered — short enough that a transient block clears
# fast, long enough not to invite a retry hammer.
BLOCK_RETRY_AFTER = _int_env('MYELIN_BLOCK_RETRY_AFTER', 15, 1, 300)

_BLOCK_MARKER_RAW = os.environ.get('MYELIN_BLOCK_MARKER', 'netfree')
BLOCK_MARKER: Optional[bytes] = _BLOCK_MARKER_RAW.lower().encode() if _BLOCK_MARKER_RAW else None

# Keep domain-file fallback for backwards compat (deprecated, prefer OVERRIDE_PROXY)
_VPN_FILE_RAW = os.environ.get('MYELIN_VPN_DOMAINS_FILE', '')
VPN_DOMAINS_FILE: Optional[Path] = Path(_VPN_FILE_RAW) if _VPN_FILE_RAW else None

# ---------------------------------------------------------------------------
# Copilot-Headroom loopback (full-pipeline routing)
#
# Instead of the stateless /v1/compress sidecar call, Copilot completion
# traffic can be redirected to a dedicated Headroom instance so it gets
# Headroom's full pipeline (cache-mode, content_router, TOIN, stats) — the
# same treatment Claude Code already gets.
#
# The dedicated instance must not know Copilot's real provider URL. Its target
# is mitmproxy's local egress listener. The ingress leg carries the original
# destination in private headers; the egress leg restores host/port/scheme/path
# before forwarding to the real provider.
#
# MYELIN_COPILOT_HEADROOM_PORT: local port of the dedicated instance.
#   Unset/0 = feature disabled, falls back to the existing /v1/compress path.
# MYELIN_EGRESS_PORT: the arrival port that identifies a flow as the
#   *egress* leg (Copilot-Headroom's loopback call back into mitmproxy).
#   Flows arriving on this port are never compressed or redirected.
# ---------------------------------------------------------------------------

COPILOT_HEADROOM_PORT = int(os.environ.get('MYELIN_COPILOT_HEADROOM_PORT', '0')) or None
EGRESS_PORT           = int(os.environ.get('MYELIN_EGRESS_PORT', '0')) or None

# ---------------------------------------------------------------------------
# Thrash detection — cache repeated identical GET responses within a session
#
# Key: SHA-256 of (host, path, request_body). Value: (compressed_body, metadata).
# TTL: 5 minutes. Max entries: 500 (LRU eviction by insertion order).
# Covers repeated tool reads (file reads, grep outputs) by the same agent.
# ---------------------------------------------------------------------------

_RESPONSE_CACHE_TTL    = 300          # seconds
_RESPONSE_CACHE_MAXLEN = 500

_response_cache: 'collections.OrderedDict[str, tuple]' = collections.OrderedDict()


def _cache_key(host: str, path: str, body: bytes) -> str:
    """Stable cache key for a request."""
    return hashlib.sha256(f'{host}\x00{path}\x00'.encode() + (body or b'')).hexdigest()


def _cache_get(key: str) -> 'tuple | None':
    """Return (cached_body, metadata_dict) if key is present and not expired."""
    entry = _response_cache.get(key)
    if entry is None:
        return None
    body, meta, ts = entry
    if time.monotonic() - ts > _RESPONSE_CACHE_TTL:
        _response_cache.pop(key, None)
        return None
    # LRU: move to end
    _response_cache.move_to_end(key)
    return body, meta


def _cache_put(key: str, body: bytes, meta: dict) -> None:
    """Insert into cache; evict oldest entry if at capacity."""
    if key in _response_cache:
        _response_cache.move_to_end(key)
    _response_cache[key] = (body, meta, time.monotonic())
    while len(_response_cache) > _RESPONSE_CACHE_MAXLEN:
        _response_cache.popitem(last=False)


_COPILOT_HOST_PATTERN = re.compile(r'(^|\.)githubcopilot\.com$')

_ORIGINAL_SCHEME_HEADER = 'x-myelin-original-scheme'
_ORIGINAL_HOST_HEADER   = 'x-myelin-original-host'
_ORIGINAL_PORT_HEADER   = 'x-myelin-original-port'
_ORIGINAL_PATH_HEADER   = 'x-myelin-original-path'
_ORIGINAL_DESTINATION_HEADERS = (
    _ORIGINAL_SCHEME_HEADER,
    _ORIGINAL_HOST_HEADER,
    _ORIGINAL_PORT_HEADER,
    _ORIGINAL_PATH_HEADER,
)


def _is_copilot_host(host: str) -> bool:
    return bool(_COPILOT_HOST_PATTERN.search(host))


def _set_original_destination_headers(flow: http.HTTPFlow, host: str, path: str) -> None:
    """Carry the real provider destination across the local Headroom loop."""
    scheme = flow.request.scheme or 'https'
    default_port = 443 if scheme == 'https' else 80
    port = flow.request.port or default_port
    flow.request.headers[_ORIGINAL_SCHEME_HEADER] = scheme
    flow.request.headers[_ORIGINAL_HOST_HEADER] = host
    flow.request.headers[_ORIGINAL_PORT_HEADER] = str(port)
    flow.request.headers[_ORIGINAL_PATH_HEADER] = path


def _host_header(host: str, scheme: str, port: int) -> str:
    default_port = 443 if scheme == 'https' else 80
    return host if port == default_port else f'{host}:{port}'


def _restore_original_destination(flow: http.HTTPFlow) -> bool:
    """Restore provider destination for Copilot-Headroom traffic on egress."""
    values = {
        header: flow.request.headers.get(header, '').strip()
        for header in _ORIGINAL_DESTINATION_HEADERS
    }
    if not all(values.values()):
        return False

    host = values[_ORIGINAL_HOST_HEADER]
    if not host or not _is_copilot_host(host):
        return False

    scheme = values[_ORIGINAL_SCHEME_HEADER].lower()
    if scheme not in ('http', 'https'):
        return False

    path = values[_ORIGINAL_PATH_HEADER]
    if not path.startswith('/'):
        return False

    try:
        port = int(values[_ORIGINAL_PORT_HEADER])
    except ValueError:
        return False
    if port < 1 or port > 65535:
        return False

    flow.request.scheme = scheme
    flow.request.host = host
    flow.request.port = port
    flow.request.headers['host'] = _host_header(host, scheme, port)
    if path:
        flow.request.path = path

    for header in _ORIGINAL_DESTINATION_HEADERS:
        flow.request.headers.pop(header, None)
    flow.metadata['myelin_egress_restored'] = True
    return True


# ---------------------------------------------------------------------------
# Provider detection
#
# Instead of a static hostname map, we detect the provider from:
#   1. The request hostname (domain suffix matching)
#   2. The request path (determines wire format: anthropic vs openai)
#
# This handles all current and future Copilot subdomain variants
# (api.githubcopilot.com, api.business.githubcopilot.com, etc.)
# without any hardcoded subdomains.
#
# Format detection from path:
#   /v1/messages           → anthropic
#   /chat/completions      → openai
#   /v1/chat/completions   → openai
#   /responses             → openai   (OpenAI Responses API — Copilot's current default)
#   /v1/responses          → openai
#
# Static overrides can be added via MYELIN_EXTRA_PROVIDERS (JSON).
# ---------------------------------------------------------------------------

import re as _re

# Domain suffix patterns → default format hint (overridden by path detection)
_DOMAIN_PATTERNS: list[tuple] = [
    (_re.compile(r'(^|\.)githubcopilot\.com$'),   'auto'),   # all copilot subdomains
    (_re.compile(r'^api\.anthropic\.com$'),         'anthropic'),
    (_re.compile(r'^api\.openai\.com$'),            'openai'),
    (_re.compile(r'openai\.azure\.com$'),           'openai'),
]

# Paths that indicate an LLM completion request worth intercepting
_COMPLETION_PATHS = {
    '/v1/messages':          'anthropic',
    '/chat/completions':     'openai',
    '/v1/chat/completions':  'openai',
    # OpenAI Responses API — GitHub Copilot's current streaming completion
    # endpoint. Recognising it keeps its (SSE) responses out of the thrash
    # cache; prefix matching also covers the /responses/{id} poll path. Its
    # request body uses `input`, not `messages`, so the compression step no-ops
    # safely (guarded by the messages check in the request hook) until
    # headroom-lite gains Responses-API schema support.
    '/responses':            'openai',
    '/v1/responses':         'openai',
}

# Cache format per wire format
_CACHE_FMT = {
    'anthropic': 'anthropic',
    'openai':    'openai_compat',
}

# Static overrides: MYELIN_EXTRA_PROVIDERS env var (JSON object)
# Schema: {"hostname": {"fmt": "openai|anthropic", "compress_paths": [...], "cache_fmt": ...}}
_STATIC_OVERRIDES: dict = {}
_extra_raw = os.environ.get('MYELIN_EXTRA_PROVIDERS', '')
if _extra_raw:
    try:
        _STATIC_OVERRIDES = json.loads(_extra_raw)
    except Exception:
        pass


def _detect_provider(host: str, path: str) -> Optional[dict]:
    """
    Return provider config for this host+path, or None if not interceptable.
    Config keys: fmt, cache_fmt
    """
    # Static overrides take priority
    if host in _STATIC_OVERRIDES:
        ov = _STATIC_OVERRIDES[host]
        paths = ov.get('compress_paths', list(_COMPLETION_PATHS.keys()))
        if any(path.startswith(p) or path == p for p in paths):
            return ov
        return None

    # Domain pattern matching
    domain_fmt = None
    for pat, fmt_hint in _DOMAIN_PATTERNS:
        if pat.search(host):
            domain_fmt = fmt_hint
            break

    if domain_fmt is None:
        return None

    # Path must be a known completion endpoint
    path_fmt = None
    for p, fmt in _COMPLETION_PATHS.items():
        if path.startswith(p) or path == p:
            path_fmt = fmt
            break

    if path_fmt is None:
        return None

    # 'auto' means trust the path; specific domain hints override
    fmt = path_fmt if domain_fmt == 'auto' else domain_fmt
    return {'fmt': fmt, 'cache_fmt': _CACHE_FMT.get(fmt)}


def _is_completion_path(host: str, path: str) -> bool:
    """True if host+path is an LLM completion endpoint. Completion responses are
    streaming (SSE) and non-idempotent, so they must NEVER be served from or
    stored in the thrash cache — doing so returns a stored body tagged
    application/json for a stream request, which the client's SSE parser rejects
    with 'EOF while parsing a value at line 1 column 0'."""
    return _detect_provider(host, path) is not None


def _is_streaming_response(response) -> bool:
    """Defense-in-depth: never cache a Server-Sent-Events response body
    regardless of path."""
    try:
        ct = (response.headers.get('content-type', '') or '').lower()
    except Exception:
        return False
    return 'text/event-stream' in ct


# Robust cache-safety: the exact-path _COMPLETION_PATHS allowlist is fragile —
# a new provider endpoint (e.g. the OpenAI Responses API) is silently unknown
# until someone adds it, and meanwhile its POST bodies are thrash-cache-eligible
# (a stored JSON body served for a stream => "EOF while parsing a value at line 1
# column 0"). These predicates make ANY completion traffic non-cacheable without
# a path entry: by known LLM host, or by completion-shaped request body.

# Top-level JSON keys that mark a request as an LLM completion across providers.
_COMPLETION_BODY_KEYS = ('messages', 'input', 'prompt', 'contents', 'instructions')
# Never parse a multi-MB body just to classify it — completion markers are always
# near the top of the object, but a huge body is a completion anyway; short-circuit.
_MAX_BODY_SNIFF_BYTES = 2 * 1024 * 1024


def _is_llm_host(host: str) -> bool:
    """True if host is a known LLM provider (matches _DOMAIN_PATTERNS)."""
    if not host:
        return False
    return any(pat.search(host) for pat, _fmt in _DOMAIN_PATTERNS)


def _body_looks_like_completion(body: bytes) -> bool:
    """Best-effort: True if the request body is a JSON object carrying a
    completion marker key. Never raises; oversized/invalid/non-object => False."""
    if not body or len(body) > _MAX_BODY_SNIFF_BYTES:
        return False
    try:
        data = json.loads(body)
    except Exception:
        return False
    if not isinstance(data, dict):
        return False
    return any(k in data for k in _COMPLETION_BODY_KEYS)


def _is_noncacheable_request(host: str, path: str, body: bytes) -> bool:
    """Single cache-exclusion predicate: a request is non-cacheable if it is a
    recognized completion path, is bound for a known LLM host, or carries a
    completion-shaped body. Host check first so the body is only parsed for
    unknown hosts (rare)."""
    return (
        _is_completion_path(host, path)
        or _is_llm_host(host)
        or _body_looks_like_completion(body)
    )


def _normalize_endpoint_path(path: str) -> str:
    """Collapse a path to its first two segments so per-request ids don't defeat
    dedup: '/responses/resp_abc123' -> '/responses'."""
    segs = [s for s in (path or '').split('?')[0].split('/') if s]
    return '/' + '/'.join(segs[:2]) if segs else '/'


# Unknown streaming endpoints seen this process (host, normalized_path) — used to
# warn ONCE per new endpoint so provider changes are visible without log spam.
_UNKNOWN_COMPLETION_ENDPOINTS: set = set()


def _note_unknown_streaming_endpoint(host: str, path: str) -> None:
    """Warn once when a known LLM host serves a streaming response on a path we
    don't recognize — the signal that a provider added a new completion endpoint."""
    try:
        key = (host, _normalize_endpoint_path(path))
        if key in _UNKNOWN_COMPLETION_ENDPOINTS:
            return
        _UNKNOWN_COMPLETION_ENDPOINTS.add(key)
        ctx.log.warn(scrub_log_str(
            f'[myelin] ⚠ unrecognized streaming endpoint {host}{path} — not in '
            f'_COMPLETION_PATHS; caching auto-disabled (safe). Consider adding it.'))
    except Exception:
        pass

# ---------------------------------------------------------------------------
# Body codec
# ---------------------------------------------------------------------------

def _decompress_body(raw: bytes, encoding: str) -> bytes:
    """Decompress a raw HTTP body given its content-encoding. Used for both
    request and response bodies. Falls back to the raw bytes on any error
    (e.g. unknown/absent encoding)."""
    if not raw:
        return raw
    try:
        if 'gzip' in encoding:
            return gzip.decompress(raw)
        if 'br' in encoding:
            import brotli
            return brotli.decompress(raw)
    except Exception:
        pass
    return raw


def _decode_body(flow: http.HTTPFlow) -> Optional[bytes]:
    raw = flow.request.content
    if not raw:
        return None
    enc = flow.request.headers.get('content-encoding', '')
    return _decompress_body(raw, enc)


def _encode_body(data: bytes, original_encoding: str) -> bytes:
    if 'gzip' in original_encoding:
        return gzip.compress(data)
    return data


# ---------------------------------------------------------------------------
# Log sanitization — strip auth credentials from any string before logging
# ---------------------------------------------------------------------------

_AUTH_SCRUB_PATTERNS = [
    (re.compile(r'(Authorization:\s*Bearer\s+)\S+', re.IGNORECASE), r'\1[REDACTED]'),
    (re.compile(r'((?:X-Api-Key|api-key):\s*)\S+', re.IGNORECASE), r'\1[REDACTED]'),
    (re.compile(r'("(?:token|api_key|apikey|secret|password)":\s*")[^"]{8,}(")', re.IGNORECASE), r'\1[REDACTED]\2'),
    (re.compile(r'\b(ghp_|ghs_|sk-|ghu_)\w{10,}', re.IGNORECASE), '[REDACTED]'),
]


def scrub_log_str(s: str) -> str:
    """Redact auth credentials from a string before writing to any log."""
    for pattern, replacement in _AUTH_SCRUB_PATTERNS:
        s = pattern.sub(replacement, s)
    return s


def scrub_headers_for_log(headers) -> dict:
    """Return a copy of a headers dict with auth values replaced by [REDACTED].
    Accepts mitmproxy Headers objects or plain dicts."""
    redact_keys = {'authorization', 'x-api-key', 'api-key', 'x-auth-token', 'cookie', 'set-cookie'}
    result = {}
    for k, v in (headers.items() if hasattr(headers, 'items') else {}.items()):
        result[k] = '[REDACTED]' if k.lower() in redact_keys else v
    return result


# ---------------------------------------------------------------------------
# Headroom compression
# Compresses ALL message roles: prompts, assistant turns, tool results.
# Tool results are the biggest token sink (bash output, file reads, etc.).
# ---------------------------------------------------------------------------

def _compress_messages(messages: list, fmt: str, model: str = '') -> tuple:
    """
    POST to Headroom /v1/compress. PURE + thread-safe: no mitmproxy types, no
    ctx.log (runs in a worker thread). Returns
    ``(messages, tokens_before, tokens_after, ok)`` where ``ok`` is True only on
    a genuine successful compression response. A legitimate zero-token result is
    still ``ok=True``; only transport/HTTP/parse failures are ``ok=False`` so the
    circuit breaker counts real failures (a 4xx from headroom is a failure but
    NOT "unreachable").
    """
    payload = json.dumps({
        'messages': messages,
        'format': fmt,
        'model': model or 'default',
    }).encode()
    req = urllib.request.Request(
        f'{HEADROOM_BASE}/v1/compress',
        data=payload,
        headers={'Content-Type': 'application/json'},
        method='POST',
    )
    try:
        with urllib.request.urlopen(req, timeout=HEADROOM_COMPRESS_TIMEOUT_SECONDS) as resp:
            result = json.loads(resp.read())
        compressed = result.get('messages')
        if isinstance(compressed, list) and compressed:
            return compressed, result.get('tokens_before', 0), result.get('tokens_after', 0), True
        # Well-formed response but nothing usable — treat as a no-op success
        # (don't trip the breaker; compression simply had nothing to do).
        return messages, 0, 0, True
    except urllib.error.HTTPError as e:
        # Must be caught BEFORE URLError (HTTPError subclasses URLError): a 4xx/5xx
        # from headroom is a real failure, not an "unreachable" transport error.
        logger.warning(scrub_log_str(f'[myelin] compression HTTP {e.code} from headroom'))
    except urllib.error.URLError as e:
        logger.warning(scrub_log_str(f'[myelin] headroom unreachable ({HEADROOM_PORT}): {e}'))
    except Exception as e:
        logger.warning(scrub_log_str(f'[myelin] compression error: {e}'))
    return messages, 0, 0, False


def _compress_success(exc, res) -> bool:
    """Breaker predicate for the compress pool: success iff the worker returned
    a result whose trailing ``ok`` flag is True and it did not raise."""
    return exc is None and bool(res) and bool(res[-1])



# cache_control is passed through untouched — the client manages its own breakpoints.

# ---------------------------------------------------------------------------
# Block-page detection + VPN domain routing
#
# Generic mechanism: when an LLM host returns HTTP 418, some corporate/ISP
# network filters block the connection. If a VPN routing file is configured,
# we add the hostname and poll for reachability (any VPN daemon that routes
# from that file should establish the route within ~30s).
# ---------------------------------------------------------------------------

def _is_network_block(status: int, body: bytes) -> bool:
    if status != 418:
        return False
    if BLOCK_MARKER:
        return BLOCK_MARKER in body.lower()
    return True  # any 418 triggers retry when override proxy is configured


def _add_to_vpn_file(hostname: str) -> bool:
    if not VPN_DOMAINS_FILE:
        return False
    try:
        existing = VPN_DOMAINS_FILE.read_text(errors='replace')
        if hostname not in existing.splitlines():
            with open(VPN_DOMAINS_FILE, 'a') as f:
                f.write(f'\n{hostname}')
        return True
    except Exception as e:
        ctx.log.warn(scrub_log_str(f'[myelin] cannot write VPN domains file: {e}'))
        return False


def _poll_reachable(hostname: str, timeout: float = 30.0, interval: float = 1.0) -> bool:
    """Poll until hostname:443 accepts a TCP connection."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        time.sleep(interval)
        try:
            with socket.create_connection((hostname, 443), timeout=2):
                return True
        except OSError:
            pass
    return False


# ---------------------------------------------------------------------------
# SOCKS5 override-proxy relay (stdlib-only)
#
# mitmproxy's own upstream-chaining mechanism (server_conn.via, fed by
# mitmproxy.net.server_spec.parse) only understands http/https/http3/tls/
# dtls/tcp/udp/dns/quic schemes — there is no native SOCKS5 upstream support,
# in mitmproxy itself (mitmproxy's "socks5" mode is listen-side only: it lets
# mitmproxy *act as* a SOCKS5 server, not connect *through* one). Passing
# 'socks5' as the via scheme raises "Invalid server scheme: socks5".
#
# For a socks5:// MYELIN_OVERRIDE_PROXY we therefore perform our own minimal
# SOCKS5 CONNECT handshake + TLS wrap + HTTP/1.1 request/response using only
# the standard library, and set flow.response directly — bypassing
# mitmproxy's replay/via mechanism entirely for this one bypass path.
# ---------------------------------------------------------------------------

def _recv_exact(sock: socket.socket, n: int, deadline: Optional[float] = None) -> bytes:
    """Read exactly ``n`` bytes or raise ConnectionError (SOCKS replies are
    short and fixed-length; a partial recv would desync the stream). When
    ``deadline`` (monotonic) is given, enforce it across the whole read so a
    trickle-feeding peer cannot exceed the total budget."""
    buf = bytearray()
    while len(buf) < n:
        if deadline is not None:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError(f'SOCKS5 read deadline exceeded ({len(buf)}/{n} bytes)')
            sock.settimeout(remaining)
        chunk = sock.recv(n - len(buf))
        if not chunk:
            raise ConnectionError(f'SOCKS5 short read: got {len(buf)} of {n} bytes')
        buf.extend(chunk)
    return bytes(buf)


def _socks5_handshake(sock: socket.socket, target_host: str, target_port: int,
                      deadline: Optional[float] = None) -> None:
    """Minimal no-auth SOCKS5 CONNECT handshake (RFC 1928) on an open socket."""
    sock.sendall(b'\x05\x01\x00')  # ver=5, 1 auth method offered, no-auth
    reply = _recv_exact(sock, 2, deadline)
    if reply[0] != 0x05 or reply[1] != 0x00:
        raise ConnectionError(f'SOCKS5 method negotiation rejected: {reply!r}')

    addr = target_host.encode('ascii')
    req = b'\x05\x01\x00\x03' + bytes([len(addr)]) + addr + struct.pack('>H', target_port)
    sock.sendall(req)

    header = _recv_exact(sock, 4, deadline)
    if header[0] != 0x05:
        raise ConnectionError(f'SOCKS5 CONNECT reply malformed: {header!r}')
    if header[1] != 0x00:
        raise ConnectionError(f'SOCKS5 CONNECT failed, reply code {header[1]}')

    atype = header[3]
    if atype == 0x01:        # IPv4
        _recv_exact(sock, 4 + 2, deadline)
    elif atype == 0x03:      # domain name
        n = _recv_exact(sock, 1, deadline)[0]
        _recv_exact(sock, n + 2, deadline)
    elif atype == 0x04:      # IPv6
        _recv_exact(sock, 16 + 2, deadline)
    else:
        raise ConnectionError(f'SOCKS5 CONNECT unknown address type {atype}')


# Result of a pure SOCKS5 relay: applied to flow.response ON the loop thread.
ReplayResult = collections.namedtuple('ReplayResult', ('status', 'body', 'headers'))


def _socks5_relay(host: str, port: int, method: str, path: str,
                  headers: dict, body: bytes, proxy_host: str, proxy_port: int,
                  connect_timeout: float = 8.0, total_timeout: float = 15.0
                  ) -> Optional[ReplayResult]:
    """
    PURE worker (runs in a thread pool): re-send a request through a SOCKS5
    proxy and RETURN the response as plain data — never touches a mitmproxy
    flow or ctx.log. Returns a ReplayResult on success, or None on failure.

    Enforces its own deadlines because mitmproxy's per-hook timeout watchdog is
    DISABLED while a hook runs, and asyncio cannot interrupt a running thread.
    Guarantees every socket is closed on every path.
    """
    raw_sock: Optional[socket.socket] = None
    tls_sock: Optional[ssl.SSLSocket] = None
    deadline = time.monotonic() + total_timeout

    def _remaining() -> float:
        r = deadline - time.monotonic()
        if r <= 0:
            raise TimeoutError('SOCKS5 relay total deadline exceeded')
        return r

    try:
        # Clamp connect to whichever is smaller: the connect budget or the
        # remaining total budget.
        raw_sock = socket.create_connection(
            (proxy_host, proxy_port), timeout=min(connect_timeout, _remaining()))
        raw_sock.settimeout(min(connect_timeout, _remaining()))
        _socks5_handshake(raw_sock, host, port, deadline)

        ssl_ctx = ssl.create_default_context(cafile=os.environ.get('SSL_CERT_FILE') or None)
        raw_sock.settimeout(_remaining())  # bound the TLS handshake too
        tls_sock = ssl_ctx.wrap_socket(raw_sock, server_hostname=host)
        raw_sock = None  # ownership transferred to tls_sock

        tls_sock.settimeout(_remaining())
        conn = http_client.HTTPSConnection(host, port, timeout=_remaining())
        conn.sock = tls_sock

        # Duplicate header names (rare — e.g. multiple Cookie headers) collapse
        # last-wins here; acceptable for a best-effort bypass retry.
        req_headers = {
            k: v for k, v in headers.items()
            if k.lower() not in ('proxy-connection', 'connection')
        }
        tls_sock.settimeout(_remaining())
        conn.request(method, path, body=body or b'', headers=req_headers)
        resp = conn.getresponse()

        # Read the body in chunks, re-clamping the socket timeout to the
        # remaining TOTAL budget before each read — settimeout() alone only
        # bounds a single recv, so a trickle-feeding peer could otherwise block
        # the worker far past total_timeout (Slowloris).
        chunks = []
        while True:
            tls_sock.settimeout(_remaining())
            chunk = resp.read(65536)
            if not chunk:
                break
            chunks.append(chunk)
        return ReplayResult(resp.status, b''.join(chunks), dict(resp.getheaders()))
    except Exception as e:
        logger.error(scrub_log_str(
            f'[myelin] SOCKS5 override-proxy relay to {proxy_host}:{proxy_port} failed: {e}'))
        return None
    finally:
        for s in (tls_sock, raw_sock):
            if s is not None:
                try:
                    s.close()
                except OSError:
                    pass


def _socks_success(exc, res) -> bool:
    """Breaker predicate for the SOCKS pool: a relay that raised, returned None,
    or returned another 418 block page is a FAILURE (don't count it as a working
    bypass)."""
    return exc is None and res is not None and res.status != 418


def _serve_graceful_block_error(flow, host: str, reason: str) -> None:
    """Replace an unrecoverable 418 network-block response with a clean,
    parseable JSON error + 503/Retry-After.

    A 418 from a corporate network filter carries an HTML block *page*. The
    override proxy is a best-effort *second chance*; when it can't recover the
    request, handing that block page back to a streaming (SSE) client makes its
    parser fail with 'EOF while parsing a value at line 1 column 0' and then
    retry aggressively. The request was going to fail anyway (the host is
    blocked), so fail it *legibly*: a JSON error body the client can parse, with
    503 + Retry-After signalling an honest, retryable-later outage. Uses the
    Anthropic error envelope (the dominant /v1/messages traffic); a parseable
    JSON body is what avoids the EOF regardless of the exact provider shape."""
    upstream_status = getattr(flow.response, 'status_code', 418)  # the original block (418)
    msg = (f'myelin: upstream host {host} is blocked by a network filter '
           f'(HTTP {upstream_status}) and the override proxy could not recover '
           f'the request ({reason}).')
    body = json.dumps({
        'type': 'error',
        'error': {
            'type': 'api_error',
            'message': msg,
            'upstream_status': upstream_status,
        },
    }).encode()
    flow.response = http.Response.make(
        503, body,
        {'content-type': 'application/json',
         'retry-after': str(BLOCK_RETRY_AFTER),
         'x-myelin-block-bypass': reason,
         'x-myelin-upstream-status': str(upstream_status)})



# ---------------------------------------------------------------------------
# mitmproxy addon
# ---------------------------------------------------------------------------

class MyelinAddon:

    async def request(self, flow: http.HTTPFlow):
        host = flow.request.pretty_host
        path = flow.request.path

        if flow.metadata.get('myelin_egress_restored'):
            return

        # Re-entry guard: an HTTP/VPN block-bypass replay (replay.client) re-runs
        # the request hook on the SAME flow. Don't compress/inject a second time.
        if flow.metadata.get('myelin_via_override'):
            return

        # Egress is the return leg from Copilot-Headroom back to mitmproxy.
        # It restores the original provider destination (when present) and
        # then exits so the request is never cached, compressed, or redirected
        # a second time.
        arrival_port = flow.client_conn.sockname[1] if flow.client_conn.sockname else None
        is_egress_leg = EGRESS_PORT is not None and arrival_port == EGRESS_PORT
        if is_egress_leg:
            restored = _restore_original_destination(flow)
            if not restored:
                flow.response = http.Response.make(
                    502,
                    b'myelin egress missing original destination',
                    {'content-type': 'text/plain'},
                )
            return

        if flow.request.method != 'POST':
            return

        if THRASH_CACHE and not _is_noncacheable_request(host, path, flow.request.content or b''):
            # Thrash detection: return cached response for repeated identical
            # requests. Completion (streaming/SSE) paths are excluded — caching
            # and re-serving them breaks the client's stream parser. The
            # exclusion is by recognized path, known LLM host, OR completion-
            # shaped body, so a new provider endpoint is safe without a path list.
            cache_key = _cache_key(host, path, flow.request.content or b'')
            flow.metadata['myelin_cache_key'] = cache_key
            cached = _cache_get(cache_key)
            if cached is not None:
                cached_body, cached_meta = cached
                flow.response = http.Response.make(
                    200,
                    cached_body,
                    {'content-type': 'application/json'},
                )
                flow.metadata['myelin_cache_hit'] = True
                flow.metadata.update(cached_meta)
                if LOG_SAVINGS:
                    ctx.log.info(f'[myelin] cache-hit {host}{path} ({len(cached_body)}B saved)')
                return

        # Auto-detect provider from host pattern + path — no hardcoded subdomains
        provider = _detect_provider(host, path)
        if not provider:
            return

        # Eligible for full-pipeline redirect to a dedicated Copilot-Headroom
        # instance instead of the stateless /v1/compress sidecar call.
        redirect_eligible = (
            not is_egress_leg
            and COPILOT_HEADROOM_PORT is not None
            and _is_copilot_host(host)
        )

        raw_encoding = flow.request.headers.get('content-encoding', '')
        body = _decode_body(flow)
        if not body:
            return

        try:
            data = json.loads(body)
        except json.JSONDecodeError:
            return

        messages = data.get('messages')
        if not isinstance(messages, list) or not messages:
            return

        # Extract model from request body (forwarded unchanged; used for compression hints)
        model = data.get('model', '')
        flow.metadata['myelin_model'] = model

        original_size = len(body)

        # 1a. Serena context injection (request-side, SSE-safe).
        # Runs before rag_injector so both env vars can co-exist without
        # double-injection.
        if SERENA_CONTEXT:
            try:
                from serena_context import inject_serena_context
                data, _sc_meta = inject_serena_context(data, provider.get('fmt', 'anthropic'))
                messages = data.get('messages', messages)
                if _sc_meta.get('injected') and LOG_SAVINGS:
                    ctx.log.info(
                        f"[myelin] serena-context: {_sc_meta.get('snippet_count',0)} snippets "
                        f"injected (frozen_count={_sc_meta.get('frozen_count',0)})"
                    )
            except Exception as _sc_err:
                ctx.log.debug(f'[myelin] serena_context skipped: {_sc_err}')

        # 1. RAG: inject code context when serena MCP is absent
        if RAG_INJECT and not SERENA_CONTEXT:
            try:
                from rag_injector import inject_rag_context
                data = inject_rag_context(data)
                messages = data.get('messages', messages)
            except Exception as e:
                ctx.log.debug(f'[myelin] rag_inject skipped: {e}')

        # 2. Tool filtering: BM25 + optional embeddings — stays in the mitm
        # addon even for redirected flows (reduces CLI-facing tokens before
        # Headroom's own pipeline runs; matches Claude Code's path today).
        if TOOL_FILTER:
            try:
                from tool_filter import filter_tools
                tools = data.get('tools')
                if isinstance(tools, list):
                    filtered, changed = filter_tools(tools, messages)
                    # Apply the filtered set every request — not just when it
                    # changed from the previous turn. Only gating on `changed`
                    # meant the full, unfiltered tool list (front of the
                    # prompt, inside the cached prefix) shipped whenever this
                    # turn's BM25 pick happened to match the last one, causing
                    # the tool-defs block length to alternate turn-to-turn and
                    # busting the provider's prompt cache. `changed` is now
                    # only used to decide whether to log.
                    data['tools'] = filtered
                    if changed:
                        ctx.log.info(f'[myelin] tools {len(tools)}→{len(filtered)}')
            except Exception as e:
                ctx.log.debug(f'[myelin] tool_filter skipped: {e}')

        if redirect_eligible:
            # Headroom's own pipeline (cache-mode, content_router, TOIN)
            # compresses this request in full downstream — do NOT also call
            # the stateless /v1/compress sidecar (would double-compress).
            fmt = provider['fmt']
            new_body = json.dumps(data, separators=(',', ':')).encode()
            encoded_body = _encode_body(new_body, raw_encoding)
            if 'gzip' not in raw_encoding and 'br' not in raw_encoding:
                flow.request.headers.pop('content-encoding', None)
            flow.request.content = encoded_body
            flow.request.headers['content-length'] = str(len(encoded_body))

            # Bare /chat/completions -> /v1/chat/completions: Headroom
            # registers the /v1-prefixed route; its own Copilot URL builder
            # strips /v1 again before it hits the real endpoint, so the
            # round-trip nets out correctly. /v1/messages needs no rewrite.
            if fmt == 'openai' and not path.startswith('/v1/'):
                flow.request.path = '/v1' + path

            flow.metadata['myelin_redirected'] = True
            _set_original_destination_headers(flow, host, path)
            flow.request.scheme = 'http'
            flow.request.host = '127.0.0.1'
            flow.request.port = COPILOT_HEADROOM_PORT
            flow.request.headers['host'] = _host_header('127.0.0.1', 'http', COPILOT_HEADROOM_PORT)
            return

        # 3. Compress messages (all roles including tool results).
        # Offloaded to the dedicated compress pool so the blocking urllib call
        # never freezes the event loop. Fail-open: if the breaker is OPEN or the
        # pool is saturated, skip compression and forward uncompressed.
        tok_before = tok_after = 0
        if COMPRESS:
            try:
                messages, tok_before, tok_after, _ok = await submit_guarded(
                    _COMPRESS_POOL, _compress_success,
                    _compress_messages, messages, provider['fmt'], model)
                data['messages'] = messages
            except Rejected:
                pass  # breaker open / saturated → forward uncompressed

        # cache_control: passed through untouched — Copilot CLI sets its own breakpoints

        new_body = json.dumps(data, separators=(',', ':')).encode()
        compressed_size = len(new_body)

        encoded_body = _encode_body(new_body, raw_encoding)
        if 'gzip' not in raw_encoding and 'br' not in raw_encoding:
            flow.request.headers.pop('content-encoding', None)
        flow.request.content = encoded_body
        flow.request.headers['content-length'] = str(len(encoded_body))

        pct = (original_size - compressed_size) / original_size * 100 if original_size else 0
        if LOG_SAVINGS and pct > 0:
            tok_pct = (tok_before - tok_after) / tok_before * 100 if tok_before else 0
            ctx.log.info(f'[myelin] ✓ {host} {original_size}→{compressed_size}B ({pct:.1f}%) tokens {tok_before}→{tok_after} ({tok_pct:.1f}%)')

        flow.metadata['myelin_host']           = host
        flow.metadata['myelin_original_bytes'] = original_size
        flow.metadata['myelin_final_bytes']    = compressed_size
        flow.metadata['myelin_tok_before']     = tok_before
        flow.metadata['myelin_tok_after']      = tok_after

    async def response(self, flow: http.HTTPFlow):
        host = flow.request.pretty_host

        # Block bypass (opt-in: requires MYELIN_BLOCK_BYPASS=1 + MYELIN_OVERRIDE_PROXY)
        #
        # On 418 block page: relay the request through the override proxy
        # (SOCKS5 stdlib relay, or HTTP via mitmproxy's replay.client). The
        # blocking relay / reachability poll are offloaded to a dedicated thread
        # pool so they never freeze the event loop.
        if BLOCK_BYPASS and (OVERRIDE_PROXY or VPN_DOMAINS_FILE):
            body = flow.response.content or b''
            if _is_network_block(flow.response.status_code, body):
                # Don't retry a flow that already went through the override proxy
                if flow.metadata.get('myelin_via_override'):
                    ctx.log.error(scrub_log_str(f'[myelin] {host} still blocked via override proxy — giving up'))
                    _serve_graceful_block_error(flow, host, 'exhausted-after-override')
                    return

                if OVERRIDE_PROXY:
                    ctx.log.warn(
                        scrub_log_str(f'[myelin] network block on {host} (418) — retrying via {OVERRIDE_PROXY}')
                    )
                    # Mark so we don't retry infinitely (guards both branches below)
                    flow.metadata['myelin_via_override'] = True
                    parsed = urlparse(OVERRIDE_PROXY)
                    if parsed.scheme == 'socks5':
                        # mitmproxy's server_conn.via has no SOCKS5 upstream
                        # support (http/https/tls/tcp schemes only) — relay
                        # manually via a stdlib-only SOCKS5 client instead.
                        # Snapshot request data ON the loop; the worker is pure.
                        port = flow.request.port or 443
                        method = flow.request.method
                        path = flow.request.path
                        req_headers = {k: v for k, v in flow.request.headers.items(multi=True)}
                        try:
                            result = await submit_guarded(
                                _SOCKS_POOL, _socks_success,
                                _socks5_relay, host, port, method, path,
                                req_headers, flow.request.content or b'',
                                parsed.hostname, parsed.port or 1080)
                        except Rejected:
                            result = None
                            ctx.log.error(scrub_log_str(
                                f'[myelin] {host} bypass skipped — SOCKS relay breaker open/saturated'))
                        # Apply the result ON the loop thread.
                        if result is not None and result.status != 418:
                            flow.response = http.Response.make(
                                result.status, result.body, result.headers)
                            ctx.log.info(f'[myelin] {host} served via SOCKS5 override proxy')
                        else:
                            ctx.log.error(scrub_log_str(
                                f'[myelin] {host} still blocked — SOCKS5 override relay failed'))
                            _serve_graceful_block_error(flow, host, 'socks5-relay-failed')
                    else:
                        try:
                            from mitmproxy.net.server_spec import parse as parse_spec
                            # Set upstream proxy for next connection attempt
                            flow.server_conn.via = parse_spec(OVERRIDE_PROXY, 'http')
                            ctx.master.commands.call('replay.client', [flow])
                        except Exception as e:
                            ctx.log.error(scrub_log_str(f'[myelin] override proxy replay failed: {e}'))
                            _serve_graceful_block_error(flow, host, 'http-replay-failed')
                elif VPN_DOMAINS_FILE:
                    # Legacy: domain-file fallback. Offload the blocking poll
                    # through the guarded pool so it respects the admission cap
                    # (a raw executor().submit would grow the unbounded queue and
                    # starve guarded SOCKS jobs behind 30s polls).
                    ctx.log.warn(scrub_log_str(f'[myelin] network block on {host} — adding to VPN routing file'))
                    reachable = False
                    if _add_to_vpn_file(host):
                        try:
                            reachable = await submit_guarded(
                                _SOCKS_POOL, lambda exc, res: exc is None and bool(res),
                                _poll_reachable, host)
                        except Rejected:
                            reachable = False
                    if reachable:
                        ctx.log.info(f'[myelin] {host} reachable via VPN — replaying')
                        flow.metadata['myelin_via_override'] = True
                        ctx.master.commands.call('replay.client', [flow])
                    else:
                        ctx.log.error(scrub_log_str(f'[myelin] VPN routing failed for {host}'))
                        _serve_graceful_block_error(flow, host, 'vpn-route-failed')
                return

        if LOG_SAVINGS and 'myelin_original_bytes' in flow.metadata:
            orig = flow.metadata['myelin_original_bytes']
            final = flow.metadata['myelin_final_bytes']
            tok_before = flow.metadata.get('myelin_tok_before', 0)
            tok_after  = flow.metadata.get('myelin_tok_after', 0)

            # Parse actual usage from API response and compute cost at Anthropic list prices
            try:
                rbody = _decompress_body(flow.response.content or b'',
                                         flow.response.headers.get('content-encoding', ''))
                rdata = json.loads(rbody)
                usage = rdata.get('usage', {})
                if usage:
                    inp = usage.get('input_tokens') or usage.get('prompt_tokens', 0)
                    out = usage.get('output_tokens') or usage.get('completion_tokens', 0)
                    cr  = usage.get('cache_read_input_tokens', 0)
                    cw  = usage.get('cache_creation_input_tokens', 0)
                    model_log = flow.metadata.get('myelin_model', '')
                    # Anthropic list prices per MTok (input / output)
                    PRICES = {
                        'claude-sonnet-4-6': (3.00, 15.00),
                        'claude-sonnet-4.6': (3.00, 15.00),
                        'claude-sonnet-4-5': (3.00, 15.00),
                        'claude-opus-4-7':   (15.00, 75.00),
                        'claude-opus-4-6':   (15.00, 75.00),
                        'claude-haiku-4-5':  (0.80, 4.00),
                        'claude-haiku-3-5':  (0.80, 4.00),
                    }
                    pin, pout = PRICES.get(model_log, (3.00, 15.00))
                    M = 1_000_000
                    cost = (inp / M * pin) + (out / M * pout) + \
                           (cr  / M * pin * 0.10) + (cw / M * pin * 1.25)
                    # Compression saving: tokens removed × input price (those tokens were never sent)
                    tok_saved = flow.metadata.get('myelin_tok_before', 0) - \
                                flow.metadata.get('myelin_tok_after', 0)
                    saved = (tok_saved / M * pin) if tok_saved > 0 else 0.0
                    ctx.log.info(
                        f'[myelin] usage {host}'
                        f' in={inp} out={out} cache_read={cr} cache_write={cw}'
                        f' cost=${cost:.6f} saved=${saved:.6f} model={model_log}'
                    )
            except Exception:
                pass

            if orig > final:
                tok_pct = f' tokens {tok_before}→{tok_after} ({(tok_before-tok_after)/tok_before*100:.1f}%)' if tok_before else ''
                ctx.log.info(
                    f'[myelin] {host} -{orig - final}B ({(orig-final)/orig*100:.1f}%)'
                    f'{tok_pct}'
                    f' → HTTP {flow.response.status_code}'
                )

        # Detection: a known LLM host serving a streaming response on a path we
        # don't recognize is almost certainly a new completion endpoint. Warn
        # once so the provider change is visible (the safety net already made it
        # cache-safe). Guarded internally; never affects request handling.
        if (
            flow.response is not None
            and _is_llm_host(host)
            and not _is_completion_path(host, flow.request.path)
            and _is_streaming_response(flow.response)
        ):
            _note_unknown_streaming_endpoint(host, flow.request.path)

        if THRASH_CACHE and (
            not flow.metadata.get('myelin_cache_hit')
            and not flow.metadata.get('myelin_via_override')
            and not _is_completion_path(host, flow.request.path)
            and not _is_llm_host(host)
            and not _is_streaming_response(flow.response)
            and flow.response is not None
            and flow.response.status_code == 200
            and 'myelin_original_bytes' in flow.metadata
        ):
            resp_body = flow.response.content or b''
            if resp_body:
                meta = {
                    'myelin_original_bytes': flow.metadata.get('myelin_original_bytes', 0),
                    'myelin_final_bytes':    flow.metadata.get('myelin_final_bytes', 0),
                    'myelin_tok_before':     flow.metadata.get('myelin_tok_before', 0),
                    'myelin_tok_after':      flow.metadata.get('myelin_tok_after', 0),
                }
                req_key = flow.metadata.get('myelin_cache_key') or _cache_key(
                    flow.request.pretty_host,
                    flow.request.path,
                    flow.request.content or b'',
                )
                _cache_put(req_key, resp_body, meta)

    def done(self):
        """mitmproxy lifecycle: shut down the offload pools on reload/exit."""
        for pool in (_SOCKS_POOL, _COMPRESS_POOL):
            try:
                pool.shutdown(wait=False)
            except Exception:
                pass


# Hosts that must NOT be TLS-intercepted — client certificates (mTLS) won't survive CONNECT proxy.
# Passed to mitmdump via --ignore-hosts flag in the launchd/systemd service (see installMitmService).
# This list is also documented here for reference.
_IGNORE_HOSTS_PATTERNS = [
    r'.*\.akamai\.com',
    r'.*\.corp\.akamai\.com',
    r'.*\.akamaized\.net',
    r'.*\.akamaihd\.net',
    r'track\.akamai\.com',
    r'git\.source\.akamai\.com',
    r'collaborate\.akamai\.com',
]

addons = [MyelinAddon()]
