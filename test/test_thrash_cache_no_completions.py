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


def test_is_completion_path_detects_responses_api():
    # GitHub Copilot migrated to the OpenAI Responses API (/responses). It is a
    # streaming (SSE) completion endpoint, so it MUST be recognised as a
    # completion path — otherwise its POST bodies are thrash-cache-eligible and a
    # stored application/json body could be served for a stream ("EOF ... line 1
    # column 0"). Path is reported truncated in mitm logs ("/responses") but the
    # real poll path is /responses/{id}, so prefix matching must cover both.
    assert copilot_addon._is_completion_path('api.business.githubcopilot.com', '/responses')
    assert copilot_addon._is_completion_path('api.business.githubcopilot.com', '/v1/responses')
    assert copilot_addon._is_completion_path('api.business.githubcopilot.com', '/responses/resp_abc123')


def test_responses_request_does_not_serve_from_cache():
    # A repeated POST /responses must never be answered from the thrash cache.
    key = copilot_addon._cache_key('api.business.githubcopilot.com', '/responses', b'{"input":[]}')
    copilot_addon._cache_put(key, b'{"stale":"json"}', {})
    flow = _flow(path='/responses', body=b'{"input":[]}')
    asyncio.run(MyelinAddon().request(flow))
    assert flow.metadata.get('myelin_cache_hit') is not True
    assert flow.response is None


# ── Robust completion-endpoint handling (defense-in-depth + detection) ────────

def test_is_llm_host_matches_known_providers():
    for h in ('api.business.githubcopilot.com', 'api.githubcopilot.com',
              'api.anthropic.com', 'api.openai.com', 'my-resource.openai.azure.com'):
        assert copilot_addon._is_llm_host(h), h
    assert not copilot_addon._is_llm_host('example.com')
    assert not copilot_addon._is_llm_host('telemetry.example.org')


def test_body_looks_like_completion():
    f = copilot_addon._body_looks_like_completion
    assert f(b'{"messages":[{"role":"user","content":"hi"}]}')
    assert f(b'{"input":[{"role":"user"}]}')
    assert f(b'{"prompt":"hello"}')
    assert f(b'{"contents":[{"parts":[]}]}')
    assert f(b'{"instructions":"do x","model":"gpt"}')
    assert not f(b'{"foo":1,"bar":2}')
    assert not f(b'')
    assert not f(b'not json at all')
    # Oversized bodies short-circuit to False (never parse multi-MB blobs).
    assert not f(b'{"messages":[]}' + b' ' * (3 * 1024 * 1024))


def test_unknown_llm_host_path_not_served_from_cache():
    # A brand-new (unknown) completion endpoint on a known LLM host must be
    # cache-excluded WITHOUT any _COMPLETION_PATHS entry — the host rule alone
    # makes future provider endpoints safe.
    host = 'api.business.githubcopilot.com'
    path = '/some-future-endpoint'
    assert not copilot_addon._is_completion_path(host, path)  # genuinely unknown
    key = copilot_addon._cache_key(host, path, b'{"input":[]}')
    copilot_addon._cache_put(key, b'{"stale":"json"}', {})
    flow = _flow(host=host, path=path, body=b'{"input":[]}')
    asyncio.run(MyelinAddon().request(flow))
    assert flow.metadata.get('myelin_cache_hit') is not True
    assert flow.response is None


def test_completion_shaped_body_on_unknown_host_not_served():
    # Backstop: on an UNKNOWN host, a completion-shaped body is still excluded.
    host = 'gateway.example.com'
    path = '/proxy/llm'
    key = copilot_addon._cache_key(host, path, b'{"messages":[{"role":"user","content":"x"}]}')
    copilot_addon._cache_put(key, b'{"stale":"json"}', {})
    flow = _flow(host=host, path=path, body=b'{"messages":[{"role":"user","content":"x"}]}')
    asyncio.run(MyelinAddon().request(flow))
    assert flow.metadata.get('myelin_cache_hit') is not True
    assert flow.response is None


def test_nonstreaming_response_on_unknown_llm_path_not_stored():
    # Store-side: a 200 application/json response on an unknown LLM-host path must
    # NOT be stored (the host rule, not just the streaming guard, excludes it).
    flow = _flow(host='api.business.githubcopilot.com', path='/some-future-endpoint')
    flow.metadata['myelin_original_bytes'] = 100
    flow.metadata['myelin_final_bytes'] = 100
    flow.response = types.SimpleNamespace(
        status_code=200,
        content=b'{"ok":true}',
        headers=_Headers({'content-type': 'application/json'}))
    asyncio.run(MyelinAddon().response(flow))
    assert len(copilot_addon._response_cache) == 0, 'LLM-host response must not be cached'


def test_detects_unrecognized_streaming_endpoint_once():
    copilot_addon._UNKNOWN_COMPLETION_ENDPOINTS.clear()
    host = 'api.business.githubcopilot.com'

    def _mk(path):
        flow = _flow(host=host, path=path)
        flow.response = types.SimpleNamespace(
            status_code=200,
            content=b'event: x\ndata: {}\n\n',
            headers=_Headers({'content-type': 'text/event-stream'}))
        return flow

    warnings = []
    orig_warn = copilot_addon.ctx.log.warn
    copilot_addon.ctx.log.warn = lambda *a, **k: warnings.append(a[0] if a else '')
    try:
        # Same base route, DIFFERENT per-request ids — must warn only ONCE.
        asyncio.run(MyelinAddon().response(_mk('/some-future-endpoint/id-123')))
        asyncio.run(MyelinAddon().response(_mk('/some-future-endpoint/id-999')))
        asyncio.run(MyelinAddon().response(_mk('/some-future-endpoint/resp_abcdef')))
    finally:
        copilot_addon.ctx.log.warn = orig_warn

    # Recorded once (deduped by host + normalized static route), logged once.
    recorded = [e for e in copilot_addon._UNKNOWN_COMPLETION_ENDPOINTS if e[0] == host]
    assert len(recorded) == 1, recorded
    assert recorded[0][1] == '/some-future-endpoint', recorded
    assert sum('unrecognized streaming endpoint' in str(w) for w in warnings) == 1


def test_normalize_endpoint_path_strips_ids():
    n = copilot_addon._normalize_endpoint_path
    assert n('/responses/resp_abc123') == '/responses'
    assert n('/v1/responses/resp_x9') == '/v1/responses'
    assert n('/some-future-endpoint/id-123') == '/some-future-endpoint'
    assert n('/v1/embeddings') == '/v1/embeddings'  # static route kept
    assert n('/responses') == '/responses'


def test_known_streaming_endpoint_not_flagged():
    copilot_addon._UNKNOWN_COMPLETION_ENDPOINTS.clear()
    flow = _flow(host='api.business.githubcopilot.com', path='/responses/resp_abc')
    flow.response = types.SimpleNamespace(
        status_code=200,
        content=b'event: x\ndata: {}\n\n',
        headers=_Headers({'content-type': 'text/event-stream'}))
    asyncio.run(MyelinAddon().response(flow))
    assert len(copilot_addon._UNKNOWN_COMPLETION_ENDPOINTS) == 0


if __name__ == '__main__':
    import pytest
    raise SystemExit(pytest.main([__file__, '-v']))
