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
  MYELIN_RAG_INJECT          1/0
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

import gzip
import json
import logging
import socket
import subprocess
import time
import urllib.request
import urllib.error
from pathlib import Path
from typing import Optional

from mitmproxy import ctx, http

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Configuration — read from env vars, all optional
# ---------------------------------------------------------------------------

HEADROOM_PORT   = int(os.environ.get('MYELIN_HEADROOM_PORT', '8787'))
HEADROOM_BASE   = f'http://127.0.0.1:{HEADROOM_PORT}'

COMPRESS     = os.environ.get('MYELIN_COMPRESS',    '1') == '1'
TOOL_FILTER  = os.environ.get('MYELIN_TOOL_FILTER', '1') == '1'
RAG_INJECT   = os.environ.get('MYELIN_RAG_INJECT',  '1') == '1'
LOG_SAVINGS  = os.environ.get('MYELIN_LOG_SAVINGS', '1') == '1'

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

_BLOCK_MARKER_RAW = os.environ.get('MYELIN_BLOCK_MARKER', 'netfree')
BLOCK_MARKER: Optional[bytes] = _BLOCK_MARKER_RAW.lower().encode() if _BLOCK_MARKER_RAW else None

# Keep domain-file fallback for backwards compat (deprecated, prefer OVERRIDE_PROXY)
_VPN_FILE_RAW = os.environ.get('MYELIN_VPN_DOMAINS_FILE', '')
VPN_DOMAINS_FILE: Optional[Path] = Path(_VPN_FILE_RAW) if _VPN_FILE_RAW else None

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

# ---------------------------------------------------------------------------
# Body codec
# ---------------------------------------------------------------------------

def _decode_body(flow: http.HTTPFlow) -> Optional[bytes]:
    raw = flow.request.content
    if not raw:
        return None
    enc = flow.request.headers.get('content-encoding', '')
    try:
        if 'gzip' in enc:
            return gzip.decompress(raw)
        if 'br' in enc:
            import brotli
            return brotli.decompress(raw)
    except Exception:
        pass
    return raw


def _encode_body(data: bytes, original_encoding: str) -> bytes:
    if 'gzip' in original_encoding:
        return gzip.compress(data)
    return data

# ---------------------------------------------------------------------------
# Headroom compression
# Compresses ALL message roles: prompts, assistant turns, tool results.
# Tool results are the biggest token sink (bash output, file reads, etc.).
# ---------------------------------------------------------------------------

def _compress_messages(messages: list, fmt: str, model: str = '') -> tuple:
    """POST to Headroom /v1/compress. Returns (messages, tokens_before, tokens_after)."""
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
        with urllib.request.urlopen(req, timeout=8) as resp:
            result = json.loads(resp.read())
            compressed = result.get('messages')
            if isinstance(compressed, list) and compressed:
                return compressed, result.get('tokens_before', 0), result.get('tokens_after', 0)
    except urllib.error.URLError as e:
        ctx.log.warn(f'[myelin] headroom unreachable ({HEADROOM_PORT}): {e}')
    except Exception as e:
        ctx.log.warn(f'[myelin] compression error: {e}')
    return messages, 0, 0

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
        ctx.log.warn(f'[myelin] cannot write VPN domains file: {e}')
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
# mitmproxy addon
# ---------------------------------------------------------------------------

class MyelinAddon:

    def request(self, flow: http.HTTPFlow):
        host = flow.request.pretty_host
        path = flow.request.path

        if flow.request.method != 'POST':
            return

        # Auto-detect provider from host pattern + path — no hardcoded subdomains
        provider = _detect_provider(host, path)
        if not provider:
            return

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

        # 1. RAG: inject code context when serena MCP is absent
        if RAG_INJECT:
            try:
                from rag_injector import inject_rag_context
                data = inject_rag_context(data)
                messages = data.get('messages', messages)
            except Exception as e:
                ctx.log.debug(f'[myelin] rag_inject skipped: {e}')

        # 2. Tool filtering: BM25 + optional embeddings
        if TOOL_FILTER:
            try:
                from tool_filter import filter_tools
                tools = data.get('tools')
                if isinstance(tools, list):
                    filtered, changed = filter_tools(tools, messages)
                    if changed:
                        data['tools'] = filtered
                        ctx.log.info(f'[myelin] tools {len(tools)}→{len(filtered)}')
            except Exception as e:
                ctx.log.debug(f'[myelin] tool_filter skipped: {e}')

        # 3. Compress messages (all roles including tool results)
        if COMPRESS:
            messages, tok_before, tok_after = _compress_messages(messages, provider['fmt'], model)
            data['messages'] = messages

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

    def response(self, flow: http.HTTPFlow):
        host = flow.request.pretty_host

        # Block bypass (opt-in: requires MYELIN_BLOCK_BYPASS=1 + MYELIN_OVERRIDE_PROXY)
        #
        # On 418 block page: set flow.server_conn.via to route the replayed request
        # directly through the override proxy (SOCKS5/HTTP VPN endpoint).
        # No domain file, no polling daemon — mitmproxy switches the transport per-flow.
        if BLOCK_BYPASS and (OVERRIDE_PROXY or VPN_DOMAINS_FILE):
            body = flow.response.content or b''
            if _is_network_block(flow.response.status_code, body):
                # Don't retry a flow that already went through the override proxy
                if flow.metadata.get('myelin_via_override'):
                    ctx.log.error(f'[myelin] {host} still blocked via override proxy — giving up')
                    return

                if OVERRIDE_PROXY:
                    ctx.log.warn(
                        f'[myelin] network block on {host} (418) — retrying via {OVERRIDE_PROXY}'
                    )
                    try:
                        from mitmproxy.net.server_spec import parse as parse_spec
                        # Mark replayed flow so we don't retry infinitely
                        flow.metadata['myelin_via_override'] = True
                        # Set upstream proxy for next connection attempt
                        flow.server_conn.via = parse_spec(OVERRIDE_PROXY, 'socks5')
                        ctx.master.commands.call('replay.client', [flow])
                    except Exception as e:
                        ctx.log.error(f'[myelin] override proxy replay failed: {e}')
                elif VPN_DOMAINS_FILE:
                    # Legacy: domain-file fallback
                    ctx.log.warn(f'[myelin] network block on {host} — adding to VPN routing file')
                    if _add_to_vpn_file(host) and _poll_reachable(host):
                        ctx.log.info(f'[myelin] {host} reachable via VPN — replaying')
                        flow.metadata['myelin_via_override'] = True
                        ctx.master.commands.call('replay.client', [flow])
                    else:
                        ctx.log.error(f'[myelin] VPN routing failed for {host}')
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

