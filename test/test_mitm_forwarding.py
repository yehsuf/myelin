"""MITM forwarding invariance — the CORE "man in the middle" contract.

The mitmproxy addon (copilot_addon.MyelinAddon) must:

  1. In the default sidecar path (no MYELIN_COPILOT_HEADROOM_PORT set),
     NEVER rewrite `flow.request.host`, `flow.request.port`, or
     `flow.request.scheme`. mitmproxy forwards the (body-modified) request
     to the ORIGINAL destination.

  2. In the copilot-headroom full-proxy path, redirect only to the local
     Copilot-Headroom instance and carry the original destination in private
     headers. The egress listener must restore that destination before
     forwarding to the real provider.

  3. Call headroom `/v1/compress` at the local sidecar port (default 8787),
     get back compressed messages, and replace `flow.request.content` with
     the compressed JSON body.

Regression this guards: the July 2026 "418 to api.anthropic.com" — when
ANTHROPIC_BASE_URL was globally set, Copilot skipped mitmproxy entirely.
This test proves the addon itself does the right thing when it IS given
traffic, so ANY future breakage will come from routing/setup, not the addon.
"""
import json
import os
import sys
import types
from unittest.mock import MagicMock, patch


# -----------------------------------------------------------------------------
# Stub mitmproxy BEFORE importing the addon (mirrors test_thrash_cache.py).
# -----------------------------------------------------------------------------

mitmproxy_stub = types.ModuleType('mitmproxy')
mitmproxy_stub.ctx = types.SimpleNamespace(log=types.SimpleNamespace(
    info=lambda *a, **k: None,
    warn=lambda *a, **k: None,
    debug=lambda *a, **k: None,
    error=lambda *a, **k: None,
))
http_stub = types.ModuleType('mitmproxy.http')
http_stub.HTTPFlow = object
http_stub.Response = types.SimpleNamespace(make=lambda status, body, headers: (status, body, headers))
sys.modules['mitmproxy'] = mitmproxy_stub
sys.modules['mitmproxy.http'] = http_stub

# Force clean env while importing the addon — no redirect path, no cache/tool-
# filter interference. Restore the process env immediately after import so this
# module does not pollute unrelated pytest modules imported later in the same
# Python process.
_ENV_OVERRIDES = {
    'MYELIN_COPILOT_HEADROOM_PORT': None,
    'MYELIN_THRASH_CACHE': '0',
    'MYELIN_LOG_SAVINGS': '0',
    'MYELIN_TOOL_FILTER': '0',
    'MYELIN_RAG_INJECT': '0',
}
_SAVED_ENV = {k: os.environ.get(k) for k in _ENV_OVERRIDES}
for _key, _value in _ENV_OVERRIDES.items():
    if _value is None:
        os.environ.pop(_key, None)
    else:
        os.environ[_key] = _value

# Re-import addon fresh (env-based constants read at import time).
if 'copilot_addon' in sys.modules:
    del sys.modules['copilot_addon']

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'src', 'mitm'))
import copilot_addon  # noqa: E402
from copilot_addon import MyelinAddon  # noqa: E402

for _key, _value in _SAVED_ENV.items():
    if _value is None:
        os.environ.pop(_key, None)
    else:
        os.environ[_key] = _value


# -----------------------------------------------------------------------------
# Fake HTTPFlow with the minimum attributes the addon uses.
# -----------------------------------------------------------------------------

class FakeHeaders:
    def __init__(self, initial=None):
        self._d = {k.lower(): v for k, v in (initial or {}).items()}

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


def _make_flow(host, path='/v1/messages', method='POST', body=None):
    if body is None:
        body = {
            'model': 'claude-sonnet-4-6',
            'messages': [{'role': 'user', 'content': 'hello'}],
        }
    body_bytes = json.dumps(body).encode()

    class Req:
        pass
    r = Req()
    r.method = method
    r.host = host
    r.pretty_host = host
    r.port = 443
    r.scheme = 'https'
    r.path = path
    r.content = body_bytes
    r.headers = FakeHeaders({'content-type': 'application/json'})

    class Conn:
        sockname = ('127.0.0.1', 8888)

    class F:
        request = r
        client_conn = Conn()
        metadata = {}
        response = None
    return F()


def _make_egress_flow(host, path='/v1/messages', method='POST', body=None):
    flow = _make_flow(host, path, method, body)
    flow.client_conn.sockname = ('127.0.0.1', 8889)
    return flow


def _mock_headroom_compress():
    """Return a MagicMock context-manager mimicking headroom /v1/compress."""
    fake = MagicMock()
    fake.read.return_value = json.dumps({
        'messages': [{'role': 'user', 'content': 'compressed-body'}],
        'tokens_before': 100,
        'tokens_after': 40,
    }).encode()
    fake.__enter__ = MagicMock(return_value=fake)
    fake.__exit__ = MagicMock(return_value=False)
    return fake


# -----------------------------------------------------------------------------
# Tests — MITM forwarding invariance
# -----------------------------------------------------------------------------

def test_mitm_preserves_copilot_destination():
    """flow.request.host/port/scheme must NOT be rewritten for a Copilot host."""
    flow = _make_flow('api.githubcopilot.com', '/chat/completions')
    origin = (flow.request.host, flow.request.port, flow.request.scheme)
    with patch('urllib.request.urlopen', return_value=_mock_headroom_compress()):
        MyelinAddon().request(flow)
    assert (flow.request.host, flow.request.port, flow.request.scheme) == origin, (
        f'MITM rewrote destination: {origin} → '
        f'({flow.request.host}, {flow.request.port}, {flow.request.scheme})'
    )


def test_mitm_preserves_business_copilot_destination():
    flow = _make_flow('api.business.githubcopilot.com', '/chat/completions')
    origin = (flow.request.host, flow.request.port, flow.request.scheme)
    with patch('urllib.request.urlopen', return_value=_mock_headroom_compress()):
        MyelinAddon().request(flow)
    assert (flow.request.host, flow.request.port, flow.request.scheme) == origin


def test_copilot_headroom_redirect_carries_original_destination():
    """Full-proxy mode redirects to local copilot-headroom only; the original
    provider destination is carried out-of-band for the egress listener."""
    flow = _make_flow('api.business.githubcopilot.com', '/chat/completions')
    old_copilot = copilot_addon.COPILOT_HEADROOM_PORT
    old_egress = copilot_addon.EGRESS_PORT
    try:
        copilot_addon.COPILOT_HEADROOM_PORT = 8788
        copilot_addon.EGRESS_PORT = 8889
        MyelinAddon().request(flow)
    finally:
        copilot_addon.COPILOT_HEADROOM_PORT = old_copilot
        copilot_addon.EGRESS_PORT = old_egress

    assert (flow.request.host, flow.request.port, flow.request.scheme) == (
        '127.0.0.1', 8788, 'http',
    )
    assert flow.request.headers['host'] == '127.0.0.1:8788'
    assert flow.request.headers['x-myelin-original-scheme'] == 'https'
    assert flow.request.headers['x-myelin-original-host'] == 'api.business.githubcopilot.com'
    assert flow.request.headers['x-myelin-original-port'] == '443'
    assert flow.request.headers['x-myelin-original-path'] == '/chat/completions'


def test_egress_listener_restores_original_destination_and_path():
    """The copilot-headroom outbound leg returns to mitmproxy's egress listener;
    mitmproxy restores the true Copilot destination before forwarding."""
    flow = _make_egress_flow('127.0.0.1', '/v1/chat/completions')
    flow.request.port = 8889
    flow.request.scheme = 'http'
    flow.request.headers['x-myelin-original-scheme'] = 'https'
    flow.request.headers['x-myelin-original-host'] = 'api.githubcopilot.com'
    flow.request.headers['x-myelin-original-port'] = '443'
    flow.request.headers['x-myelin-original-path'] = '/chat/completions'
    original_body = flow.request.content

    old_egress = copilot_addon.EGRESS_PORT
    try:
        copilot_addon.EGRESS_PORT = 8889
        with patch('urllib.request.urlopen') as mock:
            MyelinAddon().request(flow)
    finally:
        copilot_addon.EGRESS_PORT = old_egress

    assert mock.call_count == 0
    assert flow.request.scheme == 'https'
    assert flow.request.host == 'api.githubcopilot.com'
    assert flow.request.port == 443
    assert flow.request.path == '/chat/completions'
    assert flow.request.headers['host'] == 'api.githubcopilot.com'
    assert flow.request.content == original_body
    assert 'x-myelin-original-scheme' not in flow.request.headers
    assert 'x-myelin-original-host' not in flow.request.headers
    assert 'x-myelin-original-port' not in flow.request.headers
    assert 'x-myelin-original-path' not in flow.request.headers


def test_egress_listener_restores_original_destination_for_non_post():
    """Egress restore runs before method filtering, so non-POST loopback
    requests cannot self-proxy back into :8889."""
    flow = _make_egress_flow('127.0.0.1', '/models', method='GET')
    flow.request.port = 8889
    flow.request.scheme = 'http'
    flow.request.headers['x-myelin-original-scheme'] = 'https'
    flow.request.headers['x-myelin-original-host'] = 'api.githubcopilot.com'
    flow.request.headers['x-myelin-original-port'] = '443'
    flow.request.headers['x-myelin-original-path'] = '/models'

    old_egress = copilot_addon.EGRESS_PORT
    try:
        copilot_addon.EGRESS_PORT = 8889
        with patch('urllib.request.urlopen') as mock:
            MyelinAddon().request(flow)
    finally:
        copilot_addon.EGRESS_PORT = old_egress

    assert mock.call_count == 0
    assert flow.request.scheme == 'https'
    assert flow.request.host == 'api.githubcopilot.com'
    assert flow.request.port == 443
    assert flow.request.path == '/models'
    assert flow.request.headers['host'] == 'api.githubcopilot.com'


def test_egress_listener_without_loopback_headers_fails_closed():
    """The egress listener must fail closed when loopback metadata is missing."""
    flow = _make_egress_flow('api.githubcopilot.com', '/chat/completions')
    original_body = flow.request.content

    old_egress = copilot_addon.EGRESS_PORT
    try:
        copilot_addon.EGRESS_PORT = 8889
        with patch('urllib.request.urlopen') as mock:
            MyelinAddon().request(flow)
    finally:
        copilot_addon.EGRESS_PORT = old_egress

    assert mock.call_count == 0
    assert flow.request.content == original_body
    assert flow.request.host == 'api.githubcopilot.com'
    assert flow.response is not None
    assert flow.response[0] == 502


def test_egress_listener_with_partial_or_malformed_loopback_headers_fails_closed():
    """Egress metadata is all-or-nothing; defaults would silently misroute."""
    cases = [
        {'x-myelin-original-host': 'api.githubcopilot.com', 'x-myelin-original-port': '443', 'x-myelin-original-path': '/chat/completions'},
        {'x-myelin-original-scheme': 'https', 'x-myelin-original-port': '443', 'x-myelin-original-path': '/chat/completions'},
        {'x-myelin-original-scheme': 'https', 'x-myelin-original-host': 'api.githubcopilot.com', 'x-myelin-original-path': '/chat/completions'},
        {'x-myelin-original-scheme': 'https', 'x-myelin-original-host': 'api.githubcopilot.com', 'x-myelin-original-port': '443'},
        {'x-myelin-original-scheme': 'ftp', 'x-myelin-original-host': 'api.githubcopilot.com', 'x-myelin-original-port': '443', 'x-myelin-original-path': '/chat/completions'},
        {'x-myelin-original-scheme': 'https', 'x-myelin-original-host': 'api.githubcopilot.com', 'x-myelin-original-port': 'not-a-port', 'x-myelin-original-path': '/chat/completions'},
        {'x-myelin-original-scheme': 'https', 'x-myelin-original-host': 'api.githubcopilot.com', 'x-myelin-original-port': '70000', 'x-myelin-original-path': '/chat/completions'},
        {'x-myelin-original-scheme': 'https', 'x-myelin-original-host': 'api.githubcopilot.com', 'x-myelin-original-port': '443', 'x-myelin-original-path': 'chat/completions'},
        {'x-myelin-original-scheme': 'https', 'x-myelin-original-host': 'example.com', 'x-myelin-original-port': '443', 'x-myelin-original-path': '/chat/completions'},
    ]

    old_egress = copilot_addon.EGRESS_PORT
    try:
        copilot_addon.EGRESS_PORT = 8889
        for headers in cases:
            flow = _make_egress_flow('127.0.0.1', '/v1/chat/completions')
            flow.request.port = 8889
            flow.request.scheme = 'http'
            for key, value in headers.items():
                flow.request.headers[key] = value
            with patch('urllib.request.urlopen') as mock:
                MyelinAddon().request(flow)
            assert mock.call_count == 0
            assert flow.response is not None, headers
            assert flow.response[0] == 502, headers
    finally:
        copilot_addon.EGRESS_PORT = old_egress


def test_egress_listener_reentry_after_restore_is_noop():
    """mitmproxy replay.client can re-run request hooks on the same flow."""
    flow = _make_egress_flow('127.0.0.1', '/v1/chat/completions')
    flow.request.port = 8889
    flow.request.scheme = 'http'
    flow.request.headers['x-myelin-original-scheme'] = 'https'
    flow.request.headers['x-myelin-original-host'] = 'api.githubcopilot.com'
    flow.request.headers['x-myelin-original-port'] = '443'
    flow.request.headers['x-myelin-original-path'] = '/chat/completions'

    old_egress = copilot_addon.EGRESS_PORT
    old_copilot = copilot_addon.COPILOT_HEADROOM_PORT
    try:
        copilot_addon.EGRESS_PORT = 8889
        copilot_addon.COPILOT_HEADROOM_PORT = 8788
        MyelinAddon().request(flow)
        assert flow.metadata['myelin_egress_restored'] is True

        flow.client_conn.sockname = None
        with patch('urllib.request.urlopen') as mock:
            MyelinAddon().request(flow)
        assert mock.call_count == 0
    finally:
        copilot_addon.EGRESS_PORT = old_egress
        copilot_addon.COPILOT_HEADROOM_PORT = old_copilot

    assert flow.response is None
    assert flow.request.scheme == 'https'
    assert flow.request.host == 'api.githubcopilot.com'
    assert flow.request.port == 443
    assert flow.request.path == '/chat/completions'
    assert flow.request.headers['host'] == 'api.githubcopilot.com'


def test_mitm_preserves_anthropic_destination():
    """Even for direct api.anthropic.com traffic (should be rare from Copilot),
    the addon must not redirect it to headroom on 127.0.0.1."""
    flow = _make_flow('api.anthropic.com', '/v1/messages')
    origin = (flow.request.host, flow.request.port, flow.request.scheme)
    with patch('urllib.request.urlopen', return_value=_mock_headroom_compress()):
        MyelinAddon().request(flow)
    assert (flow.request.host, flow.request.port, flow.request.scheme) == origin


def test_mitm_preserves_openai_destination():
    flow = _make_flow('api.openai.com', '/v1/chat/completions')
    origin = (flow.request.host, flow.request.port, flow.request.scheme)
    with patch('urllib.request.urlopen', return_value=_mock_headroom_compress()):
        MyelinAddon().request(flow)
    assert (flow.request.host, flow.request.port, flow.request.scheme) == origin


def test_mitm_replaces_body_with_compressed():
    """flow.request.content must be replaced with the compressed JSON body."""
    flow = _make_flow('api.githubcopilot.com', '/chat/completions')
    with patch('urllib.request.urlopen', return_value=_mock_headroom_compress()):
        MyelinAddon().request(flow)
    body = json.loads(flow.request.content)
    assert body['messages'][0]['content'] == 'compressed-body', (
        f'Expected compressed body, got: {body}'
    )


def test_mitm_calls_headroom_v1_compress_locally():
    """The addon must POST to the local headroom /v1/compress endpoint.
    That is the only 3rd-party-like URL it should ever construct."""
    flow = _make_flow('api.githubcopilot.com', '/chat/completions')
    captured = []

    def fake_urlopen(req, *a, **k):
        captured.append(req.full_url)
        return _mock_headroom_compress()

    with patch('urllib.request.urlopen', side_effect=fake_urlopen):
        MyelinAddon().request(flow)

    assert any('/v1/compress' in u for u in captured), (
        f'MITM did not call headroom /v1/compress; got: {captured}'
    )
    assert any('127.0.0.1:8787' in u for u in captured), (
        f'MITM did not call headroom on the local sidecar port; got: {captured}'
    )
    # Sanity: the addon should NEVER construct an outbound URL to a real
    # provider — that's mitmproxy's job (via flow.request.host).
    for u in captured:
        assert 'api.anthropic.com' not in u
        assert 'api.githubcopilot.com' not in u
        assert 'api.openai.com' not in u


def test_mitm_ignores_non_completion_paths():
    """Non-completion POSTs (e.g. /v1/models) must NOT be routed through headroom
    and must NOT have their destination rewritten either."""
    flow = _make_flow('api.githubcopilot.com', '/models')
    origin = (flow.request.host, flow.request.port, flow.request.scheme)
    original_body = flow.request.content
    with patch('urllib.request.urlopen', return_value=_mock_headroom_compress()) as mock:
        MyelinAddon().request(flow)
    # No compression call for non-completion paths.
    assert mock.call_count == 0
    # Destination unchanged.
    assert (flow.request.host, flow.request.port, flow.request.scheme) == origin
    # Body unchanged.
    assert flow.request.content == original_body


if __name__ == '__main__':
    for name, fn in list(globals().items()):
        if name.startswith('test_') and callable(fn):
            fn()
            print(f'OK {name}')
    print('all passed')
