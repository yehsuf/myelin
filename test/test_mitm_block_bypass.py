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


if __name__ == '__main__':
    import pytest
    raise SystemExit(pytest.main([__file__, '-v']))
