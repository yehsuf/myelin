#!/usr/bin/env python3
"""
Response-hook / SOCKS5 block-bypass coverage for copilot_addon.py.

The 418 -> SOCKS5 relay path (the dominant real-world code path behind a
NetFree-style filter) had ZERO test coverage before the async-offload refactor.
These tests drive the async `response` hook with a fake pure relay and assert:

  * a successful relay replaces flow.response and marks myelin_via_override
  * a relay that returns another 418 is treated as FAILURE (block preserved)
  * a relay failure (None) preserves the original 418 (fail-path contract)
  * the re-entry guard stops a second relay on an already-bypassed flow
  * when the circuit breaker is OPEN, the hook is not offloaded and the client
    still sees the upstream 418 (documented fail-path contract)
"""
import asyncio
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


def test_relay_returning_418_is_failure_block_preserved(monkeypatch):
    _reset_breaker()
    monkeypatch.setattr(copilot_addon, '_socks5_relay',
                        lambda *a, **k: ReplayResult(418, b'still-blocked', {}))
    flow = _Flow('api.business.githubcopilot.com')
    asyncio.run(MyelinAddon().response(flow))
    # Original 418 preserved (relay 418 not applied as a success).
    assert flow.response.status_code == 418
    assert flow.response.content == b'blocked'


def test_relay_failure_preserves_original_418(monkeypatch):
    _reset_breaker()
    monkeypatch.setattr(copilot_addon, '_socks5_relay', lambda *a, **k: None)
    flow = _Flow('api.business.githubcopilot.com')
    asyncio.run(MyelinAddon().response(flow))
    assert flow.response.status_code == 418


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
    assert flow.response.status_code == 418


def test_breaker_open_skips_offload_and_preserves_418(monkeypatch):
    _reset_breaker()
    # Force the breaker OPEN so admit() returns None -> Rejected.
    pool = copilot_addon._SOCKS_POOL
    pool._open_until = pool._clock() + 100

    def _relay(*a, **k):
        raise AssertionError('relay must not run when breaker is OPEN')

    monkeypatch.setattr(copilot_addon, '_socks5_relay', _relay)
    flow = _Flow('api.business.githubcopilot.com')
    asyncio.run(MyelinAddon().response(flow))
    assert flow.response.status_code == 418  # client still sees the block


if __name__ == '__main__':
    import pytest
    raise SystemExit(pytest.main([__file__, '-v']))
