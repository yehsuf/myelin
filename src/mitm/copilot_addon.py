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

import gzip
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
# Copilot-Headroom redirect (full-pipeline routing)
#
# Instead of the stateless /v1/compress sidecar call, Copilot completion
# traffic can be redirected to a dedicated Headroom instance (its own
# ANTHROPIC_TARGET_API_URL/OPENAI_TARGET_API_URL point at the real Copilot
# API) so it gets Headroom's full pipeline (cache-mode, content_router,
# TOIN, stats) — the same treatment Claude Code already gets.
#
# MYELIN_COPILOT_HEADROOM_PORT: local port of the dedicated instance.
#   Unset/0 = feature disabled, falls back to the existing /v1/compress path.
# MYELIN_EGRESS_PORT: the arrival port that identifies a flow as the
#   *egress* leg (e.g. a dedicated Headroom instance's own outbound call
#   tunneling back through this same mitmdump process). Flows arriving on
#   this port are never redirected — they must reach the real internet.
# ---------------------------------------------------------------------------

COPILOT_HEADROOM_PORT = int(os.environ.get('MYELIN_COPILOT_HEADROOM_PORT', '0')) or None
EGRESS_PORT           = int(os.environ.get('MYELIN_EGRESS_PORT', '0')) or None

_COPILOT_HOST_PATTERN = re.compile(r'(^|\.)githubcopilot\.com$')


def _is_copilot_host(host: str) -> bool:
    return bool(_COPILOT_HOST_PATTERN.search(host))


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
        with urllib.request.urlopen(req, timeout=HEADROOM_COMPRESS_TIMEOUT_SECONDS) as resp:
            result = json.loads(resp.read())
            compressed = result.get('messages')
            if isinstance(compressed, list) and compressed:
                return compressed, result.get('tokens_before', 0), result.get('tokens_after', 0)
    except urllib.error.URLError as e:
        ctx.log.warn(scrub_log_str(f'[myelin] headroom unreachable ({HEADROOM_PORT}): {e}'))
    except Exception as e:
        ctx.log.warn(scrub_log_str(f'[myelin] compression error: {e}'))
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

def _socks5_handshake(sock: socket.socket, target_host: str, target_port: int) -> None:
    """Minimal no-auth SOCKS5 CONNECT handshake (RFC 1928) on an open socket."""
    sock.sendall(b'\x05\x01\x00')  # ver=5, 1 auth method offered, no-auth
    reply = sock.recv(2)
    if len(reply) != 2 or reply[0] != 0x05 or reply[1] != 0x00:
        raise ConnectionError(f'SOCKS5 method negotiation rejected: {reply!r}')

    addr = target_host.encode('ascii')
    req = b'\x05\x01\x00\x03' + bytes([len(addr)]) + addr + struct.pack('>H', target_port)
    sock.sendall(req)

    header = sock.recv(4)
    if len(header) != 4 or header[0] != 0x05:
        raise ConnectionError(f'SOCKS5 CONNECT reply malformed: {header!r}')
    if header[1] != 0x00:
        raise ConnectionError(f'SOCKS5 CONNECT failed, reply code {header[1]}')

    atype = header[3]
    if atype == 0x01:        # IPv4
        sock.recv(4 + 2)
    elif atype == 0x03:      # domain name
        n = sock.recv(1)[0]
        sock.recv(n + 2)
    elif atype == 0x04:      # IPv6
        sock.recv(16 + 2)
    else:
        raise ConnectionError(f'SOCKS5 CONNECT unknown address type {atype}')


def _replay_via_socks5(flow: http.HTTPFlow, proxy_host: str, proxy_port: int,
                        timeout: float = 15.0) -> bool:
    """
    Re-send flow.request directly through a SOCKS5 proxy and populate
    flow.response on success. Returns True/False.
    """
    host = flow.request.pretty_host
    port = flow.request.port or 443
    raw_sock: Optional[socket.socket] = None
    try:
        raw_sock = socket.create_connection((proxy_host, proxy_port), timeout=timeout)
        raw_sock.settimeout(timeout)
        _socks5_handshake(raw_sock, host, port)

        ssl_ctx = ssl.create_default_context(cafile=os.environ.get('SSL_CERT_FILE') or None)
        tls_sock = ssl_ctx.wrap_socket(raw_sock, server_hostname=host)
        raw_sock = None  # ownership transferred to tls_sock, avoid double-close

        conn = http_client.HTTPSConnection(host, port, timeout=timeout)
        conn.sock = tls_sock

        # Note: duplicate header names (rare — e.g. multiple Cookie headers)
        # collapse last-wins here; acceptable for a best-effort bypass retry.
        req_headers = {
            k: v for k, v in flow.request.headers.items(multi=True)
            if k.lower() not in ('proxy-connection', 'connection')
        }

        conn.request(
            flow.request.method,
            flow.request.path,
            body=flow.request.content or b'',
            headers=req_headers,
        )
        resp = conn.getresponse()
        resp_body = resp.read()
        flow.response = http.Response.make(resp.status, resp_body, dict(resp.getheaders()))
        conn.close()
        return True
    except Exception as e:
        ctx.log.error(scrub_log_str(f'[myelin] SOCKS5 override-proxy relay to {proxy_host}:{proxy_port} failed: {e}'))
        return False
    finally:
        if raw_sock is not None:
            try:
                raw_sock.close()
            except OSError:
                pass


# ---------------------------------------------------------------------------
# mitmproxy addon
# ---------------------------------------------------------------------------

class MyelinAddon:

    def request(self, flow: http.HTTPFlow):
        host = flow.request.pretty_host
        path = flow.request.path

        if flow.request.method != 'POST':
            return

        # Arrival-port gating: this same addon may run on both an ingress
        # listener (tool-filter/compress/redirect) and a dedicated egress-only
        # listener (pure tunnel + block-bypass) within one mitmdump process.
        # A flow arriving on the egress port is itself outbound traffic
        # (e.g. a dedicated Headroom instance's own upstream call tunneling
        # back through here) and must never be redirected again.
        arrival_port = flow.client_conn.sockname[1] if flow.client_conn.sockname else None
        is_egress_leg = EGRESS_PORT is not None and arrival_port == EGRESS_PORT

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

        # 1. RAG: inject code context when serena MCP is absent
        if RAG_INJECT:
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
            flow.request.scheme = 'http'
            flow.request.host = '127.0.0.1'
            flow.request.port = COPILOT_HEADROOM_PORT
            if LOG_SAVINGS:
                ctx.log.info(f'[myelin] → redirected {host}{path} to Copilot-Headroom :{COPILOT_HEADROOM_PORT}')
            return

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
                    ctx.log.error(scrub_log_str(f'[myelin] {host} still blocked via override proxy — giving up'))
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
                        if _replay_via_socks5(flow, parsed.hostname, parsed.port or 1080):
                            ctx.log.info(f'[myelin] {host} served via SOCKS5 override proxy')
                        else:
                            ctx.log.error(scrub_log_str(f'[myelin] {host} still blocked — SOCKS5 override relay failed'))
                    else:
                        try:
                            from mitmproxy.net.server_spec import parse as parse_spec
                            # Set upstream proxy for next connection attempt
                            flow.server_conn.via = parse_spec(OVERRIDE_PROXY, 'http')
                            ctx.master.commands.call('replay.client', [flow])
                        except Exception as e:
                            ctx.log.error(scrub_log_str(f'[myelin] override proxy replay failed: {e}'))
                elif VPN_DOMAINS_FILE:
                    # Legacy: domain-file fallback
                    ctx.log.warn(scrub_log_str(f'[myelin] network block on {host} — adding to VPN routing file'))
                    if _add_to_vpn_file(host) and _poll_reachable(host):
                        ctx.log.info(f'[myelin] {host} reachable via VPN — replaying')
                        flow.metadata['myelin_via_override'] = True
                        ctx.master.commands.call('replay.client', [flow])
                    else:
                        ctx.log.error(scrub_log_str(f'[myelin] VPN routing failed for {host}'))
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
