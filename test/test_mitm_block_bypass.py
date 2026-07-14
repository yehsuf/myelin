#!/usr/bin/env python3
"""
Response-hook / SOCKS5 block-bypass coverage for copilot_addon.py.

The 418 -> SOCKS5 relay path (the dominant real-world code path behind a
NetFree-style filter) had ZERO test coverage before the async-offload refactor.
These tests drive the async `response` hook with a fake pure relay and assert:

  * a successful relay replaces flow.response and marks myelin_via_override
  * a relay that returns another 418 is treated as FAILURE and fails gracefully
    (clean 503 + parseable JSON error, never the raw block page)
  * a relay failure (None) fails gracefully the same way
  * the re-entry guard stops a second relay on an already-bypassed flow and
    still returns the graceful error
  * when the circuit breaker is OPEN, the hook is not offloaded and the client
    gets the graceful error instead of the unparseable block page
"""
import asyncio
import json
import os
import sys
import types

# -----------------------------------------------------------------------------
# Rich mitmproxy stub: Response.make yields an object with status_code/content
# so the response hook (which reads both) works against it.
# -----------------------------------------------------------------------------
mitmproxy_stub = types.ModuleType('mitmproxy')
mitmproxy_stub.ctx = types.SimpleNamespace(log=types.SimpleNamespace(
    info=lambda *a, **k: None, warn=lambda *a, **k: None,
    debug=lambda *a, **k: None, error=lambda *a, **k: None,
))
http_stub = types.ModuleType('mitmproxy.http')
http_stub.HTTPFlow = object


def _make_response(status, body, headers):
    return types.SimpleNamespace(status_code=status, content=body, headers=headers)


http_stub.Response = types.SimpleNamespace(make=_make_response)
sys.modules['mitmproxy'] = mitmproxy_stub
sys.modules['mitmproxy.http'] = http_stub

_ENV = {
    'MYELIN_BLOCK_BYPASS': '1',
    'MYELIN_OVERRIDE_PROXY': 'socks5://127.0.0.1:1080',
    'MYELIN_BLOCK_MARKER': '',      # any 418 triggers bypass
    'MYELIN_THRASH_CACHE': '0',
    'MYELIN_LOG_SAVINGS': '0',
    'MYELIN_COMPRESS': '0',
}
_SAVED = {k: os.environ.get(k) for k in _ENV}
os.environ.update(_ENV)

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'src', 'mitm'))
if 'copilot_addon' in sys.modules:
    del sys.modules['copilot_addon']
import copilot_addon  # noqa: E402
from copilot_addon import MyelinAddon, ReplayResult  # noqa: E402

for _k, _v in _SAVED.items():
    if _v is None:
        os.environ.pop(_k, None)
    else:
        os.environ[_k] = _v


class _Req:
    def __init__(self, host, path='/v1/messages', method='POST', body=b'{}'):
        self.host = host
        self.pretty_host = host
        self.port = 443
        self.scheme = 'https'
        self.path = path
        self.method = method
        self.content = body

        class H:
            def items(self, multi=False):
                return [('content-type', 'application/json')]
        self.headers = H()


class _Flow:
    def __init__(self, host, status=418, body=b'blocked'):
        self.request = _Req(host)
        self.response = types.SimpleNamespace(status_code=status, content=body, headers={})
        self.metadata = {}

        class Conn:
            sockname = ('127.0.0.1', 8888)
        self.client_conn = Conn()


def _reset_breaker():
    # Fresh pool state between tests.
    copilot_addon._SOCKS_POOL.shutdown(wait=True)
    copilot_addon._SOCKS_POOL = copilot_addon.GuardedPool(
        'socks', 4, failure_threshold=3, cooldown=30.0)
    # Fresh sticky-block cache between tests (guarded so this helper keeps
    # working before the feature is implemented / for tests that don't use it).
    sticky = getattr(copilot_addon, '_STICKY', None)
    if sticky is not None and hasattr(sticky, 'clear_all'):
        sticky.clear_all()


class _Clock:
    """Deterministic monotonic clock for sticky-cache TTL tests."""
    def __init__(self, t=1000.0):
        self.t = float(t)

    def __call__(self):
        return self.t

    def advance(self, dt):
        self.t += dt


class _ReqFlow:
    """A request-hook flow (response starts as None; may be replaced)."""
    def __init__(self, host, method='GET', path='/responses', body=b''):
        self.request = _Req(host, path=path, method=method, body=body)
        self.response = None
        self.metadata = {}

        class Conn:
            sockname = ('127.0.0.1', 8888)
        self.client_conn = Conn()


def test_successful_relay_replaces_response_and_marks_override(monkeypatch):
    _reset_breaker()
    monkeypatch.setattr(copilot_addon, '_socks5_relay',
                        lambda *a, **k: ReplayResult(200, b'ok-body', {'x': '1'}))
    flow = _Flow('api.business.githubcopilot.com')
    asyncio.run(MyelinAddon().response(flow))
    assert flow.response.status_code == 200
    assert flow.response.content == b'ok-body'
    assert flow.metadata.get('myelin_via_override') is True


def _assert_graceful_block_error(resp, reason=None):
    """The new fail-path contract: an unrecoverable 418 becomes a clean,
    PARSEABLE JSON error + 503/Retry-After (never the raw block page that made
    streaming clients fail with 'EOF while parsing a value at line 1 column 0')."""
    assert resp.status_code == 503
    assert resp.headers.get('content-type') == 'application/json'
    assert resp.headers.get('retry-after')
    assert resp.headers.get('x-myelin-upstream-status') == '418'
    payload = json.loads(resp.content)  # must parse — that is the whole point
    assert payload['type'] == 'error'
    assert payload['error']['upstream_status'] == 418  # original block surfaced
    assert 'HTTP 418' in payload['error']['message']
    assert 'blocked by a network filter' in payload['error']['message']
    if reason is not None:
        assert resp.headers.get('x-myelin-block-bypass') == reason


def test_relay_returning_418_fails_gracefully(monkeypatch):
    _reset_breaker()
    monkeypatch.setattr(copilot_addon, '_socks5_relay',
                        lambda *a, **k: ReplayResult(418, b'still-blocked', {}))
    flow = _Flow('api.business.githubcopilot.com')
    asyncio.run(MyelinAddon().response(flow))
    # Relay 418 is not a success; the block fails gracefully rather than handing
    # the raw block page to the client.
    _assert_graceful_block_error(flow.response, 'socks5-relay-failed')


def test_relay_failure_fails_gracefully(monkeypatch):
    _reset_breaker()
    monkeypatch.setattr(copilot_addon, '_socks5_relay', lambda *a, **k: None)
    flow = _Flow('api.business.githubcopilot.com')
    asyncio.run(MyelinAddon().response(flow))
    _assert_graceful_block_error(flow.response, 'socks5-relay-failed')


def test_reentry_guard_no_second_relay(monkeypatch):
    _reset_breaker()
    calls = {'n': 0}

    def _relay(*a, **k):
        calls['n'] += 1
        return ReplayResult(200, b'x', {})

    monkeypatch.setattr(copilot_addon, '_socks5_relay', _relay)
    flow = _Flow('api.business.githubcopilot.com')
    flow.metadata['myelin_via_override'] = True  # already bypassed once
    asyncio.run(MyelinAddon().response(flow))
    assert calls['n'] == 0  # gave up, no relay attempted
    _assert_graceful_block_error(flow.response, 'exhausted-after-override')


def test_breaker_open_skips_offload_and_fails_gracefully(monkeypatch):
    _reset_breaker()
    # Force the breaker OPEN so admit() returns None -> Rejected.
    pool = copilot_addon._SOCKS_POOL
    pool._open_until = pool._clock() + 100

    def _relay(*a, **k):
        raise AssertionError('relay must not run when breaker is OPEN')

    monkeypatch.setattr(copilot_addon, '_socks5_relay', _relay)
    flow = _Flow('api.business.githubcopilot.com')
    asyncio.run(MyelinAddon().response(flow))
    _assert_graceful_block_error(flow.response, 'socks5-relay-failed')  # clean error, not the block page


def test_socks_relay_enforces_total_deadline_across_trickle_read():
    # A proxy that trickles bytes just under the per-op timeout must still be
    # cut off by the TOTAL deadline (Slowloris protection). We stand up a fake
    # SOCKS5 proxy that completes the handshake then dribbles an HTTP response
    # one byte at a time forever.
    import socket as _s
    import struct as _st
    import threading as _t
    import time as _time

    srv = _s.socket(_s.AF_INET, _s.SOCK_STREAM)
    srv.setsockopt(_s.SOL_SOCKET, _s.SO_REUSEADDR, 1)
    srv.bind(('127.0.0.1', 0))
    srv.listen(1)
    port = srv.getsockname()[1]
    stop = _t.Event()

    def serve():
        try:
            c, _ = srv.accept()
            c.recv(3)                       # greeting
            c.sendall(b'\x05\x00')          # no-auth
            c.recv(512)                     # CONNECT request
            # success reply, BND.ADDR 0.0.0.0:0
            c.sendall(b'\x05\x00\x00\x01' + b'\x00\x00\x00\x00' + _st.pack('>H', 0))
            # NOTE: the client wraps TLS next; our fake proxy can't complete a
            # real TLS handshake, so the relay will fail there. To exercise the
            # READ deadline specifically we instead just stall — the relay's
            # deadline must still fire. Dribble nothing; hold the socket open.
            while not stop.is_set():
                _time.sleep(0.05)
            c.close()
        except OSError:
            pass

    th = _t.Thread(target=serve, daemon=True)
    th.start()
    try:
        t0 = _time.monotonic()
        # total_timeout=1s: even though TLS will stall against our fake proxy,
        # the relay must return (None) within ~the deadline, not hang.
        res = copilot_addon._socks5_relay(
            'api.example.com', 443, 'POST', '/v1/messages',
            {'content-type': 'application/json'}, b'{}',
            '127.0.0.1', port, connect_timeout=1.0, total_timeout=1.0)
        elapsed = _time.monotonic() - t0
        assert res is None
        assert elapsed < 4.0, f'relay did not honor total deadline: {elapsed:.1f}s'
    finally:
        stop.set()
        srv.close()


# =============================================================================
# Feature 1: streaming-aware, CONFIGURABLE relay timeout.
#
# The old code hardcoded total_timeout=15s. A long SSE generation relayed
# through the override proxy took longer than 15s, timed out (None), and got a
# graceful 503 — which the CLI surfaced as "transient API error, retrying". The
# relay budget must be (a) large by default so long generations survive, and
# (b) tunable via env, while the CONNECT budget stays short (fail fast on a
# dead proxy).
# =============================================================================

def test_relay_timeout_default_is_streaming_aware():
    # Default relay budget must be much larger than the old 15s hardcode so a
    # long streaming generation isn't cut into a 503; connect stays short.
    assert copilot_addon.SOCKS_RELAY_TIMEOUT >= 60
    assert copilot_addon.SOCKS_CONNECT_TIMEOUT <= 8


def test_response_hook_passes_configured_timeout_to_relay(monkeypatch):
    _reset_breaker()
    captured = {}

    def _relay(*a, **k):
        captured['args'] = a
        captured['kwargs'] = k
        return ReplayResult(200, b'ok', {})

    monkeypatch.setattr(copilot_addon, '_socks5_relay', _relay)
    monkeypatch.setattr(copilot_addon, 'SOCKS_RELAY_TIMEOUT', 99.0)
    monkeypatch.setattr(copilot_addon, 'SOCKS_CONNECT_TIMEOUT', 3.0)
    flow = _Flow('api.business.githubcopilot.com')
    asyncio.run(MyelinAddon().response(flow))
    # relay is invoked positionally: (host, port, method, path, headers, body,
    #   proxy_host, proxy_port, connect_timeout, total_timeout)
    args = captured['args']
    assert args[-1] == 99.0, f'total_timeout not wired from config: {args!r}'
    assert args[-2] == 3.0, f'connect_timeout not wired from config: {args!r}'


# =============================================================================
# Feature 2: sticky per-host block cache (deterministic unit tests).
# =============================================================================

def test_sticky_cache_marks_and_expires():
    clk = _Clock()
    cache = copilot_addon._StickyBlockCache(ttl=8.0, clock=clk)
    assert cache.is_blocked('h') is False
    cache.mark('h')
    assert cache.is_blocked('h') is True
    clk.advance(7.9)
    assert cache.is_blocked('h') is True
    clk.advance(0.2)  # now past ttl
    assert cache.is_blocked('h') is False


def test_sticky_cache_disabled_when_ttl_zero():
    cache = copilot_addon._StickyBlockCache(ttl=0.0, clock=_Clock())
    cache.mark('h')
    assert cache.is_blocked('h') is False


def test_sticky_cache_lru_bounded():
    clk = _Clock()
    cache = copilot_addon._StickyBlockCache(ttl=100.0, max_entries=2, clock=clk)
    cache.mark('a')
    cache.mark('b')
    cache.mark('c')  # evicts oldest ('a')
    assert cache.is_blocked('a') is False
    assert cache.is_blocked('b') is True
    assert cache.is_blocked('c') is True


def test_sticky_cache_clear_all():
    cache = copilot_addon._StickyBlockCache(ttl=100.0, clock=_Clock())
    cache.mark('a')
    cache.clear_all()
    assert cache.is_blocked('a') is False


# =============================================================================
# Feature 2: sticky integration with the request / response hooks.
# =============================================================================

def test_response_block_marks_host_sticky(monkeypatch):
    _reset_breaker()
    monkeypatch.setattr(copilot_addon, '_STICKY',
                        copilot_addon._StickyBlockCache(ttl=8.0, clock=_Clock()))
    monkeypatch.setattr(copilot_addon, '_socks5_relay', lambda *a, **k: None)
    flow = _Flow('api.business.githubcopilot.com')
    asyncio.run(MyelinAddon().response(flow))
    # A confirmed 418 network block must record the host as sticky-blocked so
    # subsequent requests are pre-emptively relayed.
    assert copilot_addon._STICKY.is_blocked('api.business.githubcopilot.com') is True


def test_request_hook_preemptively_relays_sticky_host(monkeypatch):
    _reset_breaker()
    sticky = copilot_addon._StickyBlockCache(ttl=8.0, clock=_Clock())
    sticky.mark('api.business.githubcopilot.com')
    monkeypatch.setattr(copilot_addon, '_STICKY', sticky)
    calls = {'n': 0}

    def _relay(*a, **k):
        calls['n'] += 1
        return ReplayResult(200, b'pre-served', {'x': '1'})

    monkeypatch.setattr(copilot_addon, '_socks5_relay', _relay)
    flow = _ReqFlow('api.business.githubcopilot.com', method='GET', path='/responses')
    asyncio.run(MyelinAddon().request(flow))
    assert calls['n'] == 1, 'sticky host was not pre-emptively relayed'
    assert flow.response is not None
    assert flow.response.status_code == 200
    assert flow.response.content == b'pre-served'
    assert flow.metadata.get('myelin_via_override') is True


def test_request_hook_sticky_relay_failopen(monkeypatch):
    _reset_breaker()
    sticky = copilot_addon._StickyBlockCache(ttl=8.0, clock=_Clock())
    sticky.mark('api.business.githubcopilot.com')
    monkeypatch.setattr(copilot_addon, '_STICKY', sticky)
    monkeypatch.setattr(copilot_addon, '_socks5_relay', lambda *a, **k: None)
    flow = _ReqFlow('api.business.githubcopilot.com', method='GET', path='/responses')
    asyncio.run(MyelinAddon().request(flow))
    # Fail-open: a failed pre-emptive relay must NOT short-circuit the request;
    # the normal path (and the response-hook bypass) still gets its chance.
    assert flow.response is None
    assert flow.metadata.get('myelin_via_override') is not True


def test_request_hook_ignores_non_sticky_host(monkeypatch):
    _reset_breaker()
    monkeypatch.setattr(copilot_addon, '_STICKY',
                        copilot_addon._StickyBlockCache(ttl=8.0, clock=_Clock()))

    def _relay(*a, **k):
        raise AssertionError('must not relay a host that is not sticky-blocked')

    monkeypatch.setattr(copilot_addon, '_socks5_relay', _relay)
    flow = _ReqFlow('api.business.githubcopilot.com', method='GET', path='/responses')
    asyncio.run(MyelinAddon().request(flow))
    assert flow.response is None


def test_request_hook_does_not_preempt_post(monkeypatch):
    # POST bodies are compressed / RAG-injected further down the request hook.
    # Pre-empting a POST here would relay the RAW body and skip the whole
    # token-efficiency pipeline, and could duplicate a non-idempotent send.
    # Only bodyless idempotent methods (the blocked GET SSE stream) are
    # pre-empted; a sticky POST must fall through to the normal path (where the
    # response-hook bypass relays the already-compressed body if it 418s).
    _reset_breaker()
    sticky = copilot_addon._StickyBlockCache(ttl=8.0, clock=_Clock())
    sticky.mark('api.business.githubcopilot.com')
    monkeypatch.setattr(copilot_addon, '_STICKY', sticky)
    monkeypatch.setattr(copilot_addon, '_detect_provider', lambda *a, **k: None)

    def _relay(*a, **k):
        raise AssertionError('a POST must not be pre-emptively relayed')

    monkeypatch.setattr(copilot_addon, '_socks5_relay', _relay)
    flow = _ReqFlow('api.business.githubcopilot.com', method='POST',
                    path='/v1/messages', body=b'{"x":1}')
    asyncio.run(MyelinAddon().request(flow))
    assert flow.response is None
    assert flow.metadata.get('myelin_via_override') is not True


if __name__ == '__main__':
    import pytest
    raise SystemExit(pytest.main([__file__, '-v']))
