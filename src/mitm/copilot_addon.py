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

# VPN bypass: only active when MYELIN_VPN_DOMAINS_FILE is explicitly set.
# This is an opt-in feature for networks that block LLM hosts and use
# a domain-routing VPN daemon (e.g. OpenVPN with a routing watcher script).
_VPN_FILE_RAW = os.environ.get('MYELIN_VPN_DOMAINS_FILE', '')
VPN_DOMAINS_FILE: Optional[Path] = Path(_VPN_FILE_RAW) if _VPN_FILE_RAW else None

# Block-page body marker: if set, a 418 is only treated as a network block
# when this byte-string appears in the response body. When unset, ANY 418
# triggers VPN retry (if VPN_DOMAINS_FILE is configured).
_BLOCK_MARKER_RAW = os.environ.get('MYELIN_BLOCK_MARKER', '')
BLOCK_MARKER: Optional[bytes] = _BLOCK_MARKER_RAW.encode() if _BLOCK_MARKER_RAW else None

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

def _compress_messages(messages: list, fmt: str, model: str = '') -> list:
    """POST to Headroom /v1/compress. Requires model field. Falls back on error."""
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
                return compressed
    except urllib.error.URLError as e:
        ctx.log.warn(f'[myelin] headroom unreachable ({HEADROOM_PORT}): {e}')
    except Exception as e:
        ctx.log.warn(f'[myelin] compression error: {e}')
    return messages

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
        return BLOCK_MARKER in body
    return True  # any 418 triggers retry when VPN file is configured


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
            messages = _compress_messages(messages, provider['fmt'], model)
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
            ctx.log.info(f'[myelin] ✓ {host} {original_size}→{compressed_size}B ({pct:.1f}%)')

        flow.metadata['myelin_host']           = host
        flow.metadata['myelin_original_bytes'] = original_size
        flow.metadata['myelin_final_bytes']    = compressed_size

    def response(self, flow: http.HTTPFlow):
        host = flow.request.pretty_host

        # Block detection + VPN retry (opt-in: requires MYELIN_VPN_DOMAINS_FILE)
        if VPN_DOMAINS_FILE:
            body = flow.response.content or b''
            if _is_network_block(flow.response.status_code, body):
                ctx.log.warn(f'[myelin] network block on {host} (418) — adding to VPN routing')
                if _add_to_vpn_file(host) and _poll_reachable(host):
                    ctx.log.info(f'[myelin] {host} reachable via VPN — replaying')
                    ctx.master.commands.call('replay.client', [flow])
                else:
                    ctx.log.error(f'[myelin] VPN routing failed for {host}')
                return

        if LOG_SAVINGS and 'myelin_original_bytes' in flow.metadata:
            orig = flow.metadata['myelin_original_bytes']
            final = flow.metadata['myelin_final_bytes']
            if orig > final:
                ctx.log.info(
                    f'[myelin] {host} -{orig - final}B ({(orig-final)/orig*100:.1f}%)'
                    f' → HTTP {flow.response.status_code}'
                )


addons = [MyelinAddon()]
