#!/usr/bin/env python3
"""
Myelin mitmproxy addon — generic LLM compression & caching proxy.

Per-request pipeline:
  1. RAG inject    — code context when serena MCP absent (ripgrep/serena fallback)
  2. Tool filter   — BM25 + optional model2vec: removes irrelevant tools from tools[]
  3. Compress      — Headroom /v1/compress shrinks ALL message types
  4. cache_control — preserves existing markers; adds ephemeral breakpoint only where absent
  5. Forward to provider (original auth headers untouched)

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

COMPRESS     = os.environ.get('MYELIN_COMPRESS',     '1') == '1'
CACHE_INJECT = os.environ.get('MYELIN_CACHE_INJECT', '1') == '1'
TOOL_FILTER  = os.environ.get('MYELIN_TOOL_FILTER',  '1') == '1'
RAG_INJECT   = os.environ.get('MYELIN_RAG_INJECT',   '1') == '1'
LOG_SAVINGS  = os.environ.get('MYELIN_LOG_SAVINGS',  '1') == '1'

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
# Provider registry
#
# Maps request hostname → compression/caching config.
# Add entries for private or enterprise LLM endpoints here, or via
# MYELIN_EXTRA_PROVIDERS env var (JSON object with the same schema).
#
# Fields:
#   compress_paths  — URL path prefixes to intercept (POST only)
#   fmt             — 'openai' | 'anthropic'  (Headroom compression schema)
#   cache_fmt       — 'anthropic' | 'openai_compat' | None
# ---------------------------------------------------------------------------

PROVIDERS: dict = {
    'api.githubcopilot.com': {
        'fmt': 'openai',
        'compress_paths': ['/chat/completions', '/v1/chat/completions'],
        'cache_fmt': 'openai_compat',
    },
    'api.anthropic.com': {
        'fmt': 'anthropic',
        'compress_paths': ['/v1/messages'],
        'cache_fmt': 'anthropic',
    },
    'api.openai.com': {
        'fmt': 'openai',
        'compress_paths': ['/v1/chat/completions'],
        'cache_fmt': None,
    },
    'openai.azure.com': {
        'fmt': 'openai',
        'compress_paths': ['/chat/completions'],
        'cache_fmt': None,
    },
}

# Merge extra providers from env var
_extra_raw = os.environ.get('MYELIN_EXTRA_PROVIDERS', '')
if _extra_raw:
    try:
        PROVIDERS.update(json.loads(_extra_raw))
    except Exception:
        pass

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

def _compress_messages(messages: list, fmt: str) -> list:
    payload = json.dumps({'messages': messages, 'format': fmt}).encode()
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

# ---------------------------------------------------------------------------
# Cache-control injection
#
# Preserves any cache_control already set by the client (e.g. Copilot CLI).
# Only adds ephemeral breakpoints on messages that don't already have one.
#
# Ordering (Anthropic spec): tools → system → messages
# Breakpoint placed on last stable assistant turn before current user turn.
# ---------------------------------------------------------------------------

def _has_cc(msg: dict) -> bool:
    if msg.get('cache_control'):
        return True
    content = msg.get('content')
    if isinstance(content, list):
        return any(isinstance(b, dict) and b.get('cache_control') for b in content)
    return False


def _inject_cache_control(messages: list, fmt: str) -> list:
    if not messages:
        return messages

    msgs = [dict(m) for m in messages]

    if fmt == 'anthropic':
        last_asst = max((i for i, m in enumerate(msgs) if m.get('role') == 'assistant'), default=None)
        if last_asst is not None and not _has_cc(msgs[last_asst]):
            content = msgs[last_asst].get('content', '')
            if isinstance(content, str):
                msgs[last_asst]['content'] = [{'type': 'text', 'text': content,
                                               'cache_control': {'type': 'ephemeral'}}]
            elif isinstance(content, list) and content:
                last_block = {**content[-1], 'cache_control': {'type': 'ephemeral'}}
                msgs[last_asst]['content'] = list(content[:-1]) + [last_block]

    elif fmt == 'openai_compat':
        last_asst = None
        for i, m in enumerate(msgs):
            if m.get('role') == 'system' and i == 0 and not _has_cc(m):
                msgs[i] = {**m, 'cache_control': {'type': 'ephemeral'}}
            if m.get('role') == 'assistant':
                last_asst = i
        if last_asst is not None and not _has_cc(msgs[last_asst]):
            msgs[last_asst] = {**msgs[last_asst], 'cache_control': {'type': 'ephemeral'}}

    return msgs

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
        provider = PROVIDERS.get(host)
        if not provider or flow.request.method != 'POST':
            return

        path = flow.request.path
        if not any(path.startswith(p) or path == p for p in provider['compress_paths']):
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
            messages = _compress_messages(messages, provider['fmt'])
            data['messages'] = messages

        # 4. Cache-control (preserves existing client markers)
        if CACHE_INJECT and provider.get('cache_fmt'):
            data['messages'] = _inject_cache_control(messages, provider['cache_fmt'])

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
