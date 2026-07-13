#!/usr/bin/env python3
"""
Regression: the thrash cache must NEVER serve or store LLM completion
(streaming/SSE) responses. Caching them returned a stored body tagged
application/json for a stream request, which the Copilot CLI's Anthropic stream
parser rejected with "EOF while parsing a value at line 1 column 0" — and the
5 retries all hit the same cached body, turning it into a retry loop.
"""
import asyncio
import os
import sys
import types

mitmproxy_stub = types.ModuleType('mitmproxy')
mitmproxy_stub.ctx = types.SimpleNamespace(log=types.SimpleNamespace(
    info=lambda *a, **k: None, warn=lambda *a, **k: None,
    debug=lambda *a, **k: None, error=lambda *a, **k: None,
))
http_stub = types.ModuleType('mitmproxy.http')
http_stub.HTTPFlow = object
http_stub.Response = types.SimpleNamespace(
    make=lambda status, body, headers: types.SimpleNamespace(
        status_code=status, content=body, headers=headers))
sys.modules.setdefault('mitmproxy', mitmproxy_stub)
sys.modules.setdefault('mitmproxy.http', http_stub)

_ENV = {
    'MYELIN_THRASH_CACHE': '1',
    'MYELIN_COMPRESS': '0',
    'MYELIN_LOG_SAVINGS': '0',
    'MYELIN_TOOL_FILTER': '0',
    'MYELIN_COPILOT_HEADROOM_PORT': None,
}
_SAVED = {k: os.environ.get(k) for k in _ENV}
for k, v in _ENV.items():
    if v is None:
        os.environ.pop(k, None)
    else:
        os.environ[k] = v

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'src', 'mitm'))
# Do NOT del/re-import copilot_addon: that orphans module-level references bound
# by other test modules (e.g. test_thrash_cache.py) and breaks their patching.
# Import once and force the module-global flags this test needs at runtime.
import copilot_addon  # noqa: E402
from copilot_addon import MyelinAddon  # noqa: E402

for k, v in _SAVED.items():
    if v is None:
        os.environ.pop(k, None)
    else:
        os.environ[k] = v


class _Headers:
    def __init__(self, d=None):
        self._d = {k.lower(): v for k, v in (d or {}).items()}

    def get(self, k, default=''):
        return self._d.get(k.lower(), default)

    def pop(self, k, default=None):
        return self._d.pop(k.lower(), default)

    def __setitem__(self, k, v):
        self._d[k.lower()] = v

    def __getitem__(self, k):
        return self._d[k.lower()]

    def __contains__(self, k):
        return k.lower() in self._d

    def items(self, multi=False):
        return list(self._d.items())


def _flow(host='api.business.githubcopilot.com', path='/v1/messages', body=b'{"messages":[]}'):
    class Req:
        pass
    r = Req()
    r.method = 'POST'
    r.host = r.pretty_host = host
    r.port = 443
    r.scheme = 'https'
    r.path = path
    r.content = body
    r.headers = _Headers({'content-type': 'application/json'})

    class Conn:
        sockname = ('127.0.0.1', 8888)

    class F:
        request = r
        client_conn = Conn()
        metadata = {}
        response = None
    return F()


def setup_function(_fn):
    copilot_addon._response_cache.clear()
    copilot_addon.THRASH_CACHE = True
    copilot_addon.COMPRESS = False
    copilot_addon.BLOCK_BYPASS = False
    copilot_addon.COPILOT_HEADROOM_PORT = None
    copilot_addon.EGRESS_PORT = None


def test_completion_response_is_not_stored_in_cache():
    flow = _flow()
    # Simulate the request hook marking it (compression path sets these).
    flow.metadata['myelin_original_bytes'] = 100
    flow.metadata['myelin_final_bytes'] = 100
    flow.response = types.SimpleNamespace(
        status_code=200,
        content=b'event: message\ndata: {"x":1}\n\n',
        headers=_Headers({'content-type': 'text/event-stream'}))
    asyncio.run(MyelinAddon().response(flow))
    assert len(copilot_addon._response_cache) == 0, 'completion response must not be cached'


def test_completion_request_does_not_serve_from_cache():
    # Pre-seed the cache with a body under the completion request's key.
    key = copilot_addon._cache_key('api.business.githubcopilot.com', '/v1/messages', b'{"messages":[]}')
    copilot_addon._cache_put(key, b'{"stale":"json"}', {})
    flow = _flow()
    asyncio.run(MyelinAddon().request(flow))
    # Must NOT have been served from cache.
    assert flow.metadata.get('myelin_cache_hit') is not True
    assert flow.response is None


def test_is_completion_path_detects_messages_and_chat():
    assert copilot_addon._is_completion_path('api.business.githubcopilot.com', '/v1/messages')
    assert copilot_addon._is_completion_path('api.githubcopilot.com', '/chat/completions')


if __name__ == '__main__':
    import pytest
    raise SystemExit(pytest.main([__file__, '-v']))
