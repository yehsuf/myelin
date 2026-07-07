#!/usr/bin/env python3
"""
Myelin mitmproxy addon — generic LLM compression & caching proxy.

Pipeline per intercepted LLM request:
  1. Provider detection (hostname → config)
  2. Decompress body (gzip/br)
  3. Headroom /v1/compress  — shrinks ALL message types: prompt, tool results, history
  4. cache_control injection — stable-prefix anchor for LLM prompt caching
  5. Forward to provider (with original auth headers intact)
  6. Response: 418 NetFree block → append to VPN domain list → poll route → replay
  7. Log token-byte delta per request

Adding a new provider: add an entry to PROVIDERS below. No other changes needed.

Configuration (env vars, all optional):
  MYELIN_HEADROOM_PORT      default: 8787
  MYELIN_VPN_DOMAINS_FILE   default: ~/openvpn-routing-scripts/domains_session.txt
  MYELIN_COMPRESS            default: 1   (set 0 to disable compression)
  MYELIN_CACHE_INJECT        default: 1   (set 0 to disable cache_control injection)
  MYELIN_VPN_RETRY           default: 1   (set 0 to disable VPN retry)
  MYELIN_LOG_SAVINGS         default: 1
"""

import gzip
import json
import logging
import os
import subprocess
import time
from pathlib import Path
from typing import Optional
import urllib.request
import urllib.error

from mitmproxy import ctx, http

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

_home = Path.home()

HEADROOM_PORT   = int(os.environ.get('MYELIN_HEADROOM_PORT', '8787'))
HEADROOM_BASE   = f'http://127.0.0.1:{HEADROOM_PORT}'

VPN_DOMAINS_FILE = Path(os.environ.get(
    'MYELIN_VPN_DOMAINS_FILE',
    str(_home / 'openvpn-routing-scripts' / 'domains_session.txt'),
))

COMPRESS     = os.environ.get('MYELIN_COMPRESS',     '1') == '1'
CACHE_INJECT = os.environ.get('MYELIN_CACHE_INJECT', '1') == '1'
VPN_RETRY    = os.environ.get('MYELIN_VPN_RETRY',    '1') == '1'
LOG_SAVINGS  = os.environ.get('MYELIN_LOG_SAVINGS',  '1') == '1'

# Marker that appears in NetFree block pages
NETFREE_MARKER = b'netfree.link/img/block-favicon.png'

# ---------------------------------------------------------------------------
# Provider registry
# Extend this dict to support additional LLM providers without touching pipeline code.
#
# Fields:
#   compress_paths  – URL path prefixes to intercept (POST only)
#   fmt             – 'openai' | 'anthropic'  (tells Headroom which schema to compress)
#   cache_fmt       – 'anthropic' | 'openai_compat' | None
#                     'anthropic'     → inject cache_control inside content blocks
#                     'openai_compat' → inject as top-level message field (passes through
#                                       to Claude backends behind OpenAI-format gateways)
#                     None            → skip injection for this provider
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
    # Azure OpenAI — path varies per deployment; adjust compress_paths as needed
    'openai.azure.com': {
        'fmt': 'openai',
        'compress_paths': ['/chat/completions'],
        'cache_fmt': None,
    },
    # Akamai/corporate Claude upstream
    'claude-llm.dash.akamai.com': {
        'fmt': 'anthropic',
        'compress_paths': ['/apim/claude', '/v1/messages'],
        'cache_fmt': 'anthropic',
    },
}


# ---------------------------------------------------------------------------
# Body helpers
# ---------------------------------------------------------------------------

def _decode_body(flow: http.HTTPFlow) -> Optional[bytes]:
    """Return decompressed body bytes, or None if empty."""
    raw = flow.request.content
    if not raw:
        return None
    enc = flow.request.headers.get('content-encoding', '')
    try:
        if 'gzip' in enc:
            return gzip.decompress(raw)
        if 'br' in enc:
            import brotli  # optional dep
            return brotli.decompress(raw)
    except Exception:
        pass
    return raw


def _encode_body(data: bytes, original_encoding: str) -> bytes:
    """Re-compress body to match original encoding."""
    if 'gzip' in original_encoding:
        return gzip.compress(data)
    return data


# ---------------------------------------------------------------------------
# Compression via Headroom /v1/compress
#
# Headroom compresses ALL message roles: user prompts, assistant turns, AND
# tool results (role:"tool" / type:"tool_result") — these grow large from
# bash output, file reads, search results and are the biggest token sink.
# ---------------------------------------------------------------------------

def _compress_messages(messages: list, fmt: str) -> list:
    """POST messages to Headroom /v1/compress. Falls back to original on error."""
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
        ctx.log.warn(f'[myelin] headroom unreachable: {e} — skipping compression')
    except Exception as e:
        ctx.log.warn(f'[myelin] compression error: {e}')
    return messages


# ---------------------------------------------------------------------------
# Cache-control injection
#
# Goal: anchor the LLM's prompt cache at the last stable message so repeated
# turns re-use the cached KV state instead of recomputing from scratch.
#
# Claude ephemeral cache = 5-minute TTL = cached tokens cost ~10% of input tokens.
# For a 10K-token context, that saves ~9K input tokens per turn after the first.
#
# Strategy:
#   1. Mark the system message (most stable content, always worth caching).
#   2. Mark the last assistant message before the most recent user turn
#      (boundary between stable history and live turn).
#
# This is safe to send even when the backend ignores unknown fields.
# ---------------------------------------------------------------------------

def _inject_cache_control(messages: list, fmt: str) -> list:
    if not messages:
        return messages

    msgs = [dict(m) for m in messages]

    if fmt == 'anthropic':
        # Mark system message (passed separately in Anthropic API — handled below)
        # Mark last assistant turn before current user input
        last_asst = None
        for i, m in enumerate(msgs):
            if m.get('role') == 'assistant':
                last_asst = i

        if last_asst is not None:
            content = msgs[last_asst].get('content', '')
            if isinstance(content, str):
                msgs[last_asst]['content'] = [{
                    'type': 'text',
                    'text': content,
                    'cache_control': {'type': 'ephemeral'},
                }]
            elif isinstance(content, list) and content:
                last_block = {**content[-1], 'cache_control': {'type': 'ephemeral'}}
                msgs[last_asst]['content'] = list(content[:-1]) + [last_block]

    elif fmt == 'openai_compat':
        # Non-standard but harmless: add cache_control at message level.
        # Claude-backed gateways (Copilot → Claude) may honor these fields.
        last_asst = None
        for i, m in enumerate(msgs):
            if m.get('role') == 'system' and i == 0:
                msgs[i] = {**m, 'cache_control': {'type': 'ephemeral'}}
            if m.get('role') == 'assistant':
                last_asst = i

        if last_asst is not None:
            msgs[last_asst] = {**msgs[last_asst], 'cache_control': {'type': 'ephemeral'}}

    return msgs


# ---------------------------------------------------------------------------
# NetFree 418 → VPN auto-retry
#
# When NetFree blocks a hostname it returns HTTP 418 with a block page
# containing NETFREE_MARKER. We add the hostname to domains_session.txt
# which the dns-watcher.sh daemon (running as root) picks up within 15s
# and adds routes to utun4. Then we replay the request.
# ---------------------------------------------------------------------------

def _add_vpn_domain(hostname: str) -> bool:
    """Append hostname to VPN routing file. Returns True if file exists."""
    if not VPN_DOMAINS_FILE.exists():
        ctx.log.warn(f'[myelin] VPN domains file not found: {VPN_DOMAINS_FILE}')
        return False
    existing = VPN_DOMAINS_FILE.read_text()
    if hostname not in existing.splitlines():
        with open(VPN_DOMAINS_FILE, 'a') as f:
            f.write(f'\n{hostname}')
        ctx.log.info(f'[myelin] Added {hostname} to {VPN_DOMAINS_FILE}')
    return True


def _poll_vpn_route(hostname: str, timeout: float = 25.0, interval: float = 0.5) -> bool:
    """Poll for a VPN route to hostname via utun4. Returns True when route appears."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        time.sleep(interval)
        try:
            result = subprocess.run(
                ['netstat', '-rn'],
                capture_output=True, text=True, timeout=3,
            )
            for line in result.stdout.splitlines():
                if 'utun4' in line:
                    # Specific host route or default via VPN
                    if hostname in line or line.lstrip().startswith('default') or line.lstrip().startswith('0.0.0.0'):
                        return True
        except Exception:
            pass
    return False


# ---------------------------------------------------------------------------
# mitmproxy addon class
# ---------------------------------------------------------------------------

class MyelinAddon:

    # ------------------------------------------------------------------
    # request hook — runs before the request is sent to the upstream
    # ------------------------------------------------------------------
    def request(self, flow: http.HTTPFlow):
        host = flow.request.pretty_host
        provider = PROVIDERS.get(host)
        if not provider:
            return

        path = flow.request.path
        if not any(path.startswith(p) or path == p
                   for p in provider['compress_paths']):
            return

        if flow.request.method != 'POST':
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

        # --- Compression (shrinks prompts + tool results + history) ---
        if COMPRESS:
            messages = _compress_messages(messages, provider['fmt'])

        # --- Cache-control injection (prompt caching anchor) ---
        if CACHE_INJECT and provider.get('cache_fmt'):
            messages = _inject_cache_control(messages, provider['cache_fmt'])

        data['messages'] = messages
        new_body = json.dumps(data, separators=(',', ':')).encode()
        compressed_size = len(new_body)

        # Re-encode body matching original content-encoding
        encoded_body = _encode_body(new_body, raw_encoding)
        if 'gzip' not in raw_encoding and 'br' not in raw_encoding:
            flow.request.headers.pop('content-encoding', None)

        flow.request.content = encoded_body
        flow.request.headers['content-length'] = str(len(encoded_body))

        saving_pct = (original_size - compressed_size) / original_size * 100 if original_size else 0
        if LOG_SAVINGS and saving_pct > 0:
            ctx.log.info(
                f'[myelin] ✓ {host} {original_size}→{compressed_size}B '
                f'({saving_pct:.1f}% saved)'
            )

        # Stash for response hook
        flow.metadata['myelin_host']             = host
        flow.metadata['myelin_original_bytes']   = original_size
        flow.metadata['myelin_compressed_bytes'] = compressed_size

    # ------------------------------------------------------------------
    # response hook — runs after the upstream responds
    # ------------------------------------------------------------------
    def response(self, flow: http.HTTPFlow):
        host = flow.request.pretty_host

        # --- NetFree 418 block detection + VPN auto-retry ---
        if VPN_RETRY and flow.response.status_code == 418:
            body = flow.response.content or b''
            if NETFREE_MARKER in body:
                ctx.log.warn(
                    f'[myelin] NetFree block on {host} — routing via VPN…'
                )
                if _add_vpn_domain(host) and _poll_vpn_route(host):
                    ctx.log.info(
                        f'[myelin] VPN route up for {host} — replaying request'
                    )
                    ctx.master.commands.call('replay.client', [flow])
                else:
                    ctx.log.error(
                        f'[myelin] VPN route failed for {host} — request remains blocked'
                    )
                return

        # --- Log final savings summary ---
        if LOG_SAVINGS and 'myelin_original_bytes' in flow.metadata:
            orig = flow.metadata['myelin_original_bytes']
            comp = flow.metadata['myelin_compressed_bytes']
            status = flow.response.status_code
            if orig > comp:
                ctx.log.info(
                    f'[myelin] {host} saved {orig - comp}B '
                    f'({(orig - comp) / orig * 100:.1f}%) → HTTP {status}'
                )


addons = [MyelinAddon()]
