"""MITM forwarding invariance — the CORE "man in the middle" contract.

The mitmproxy addon (copilot_addon.MyelinAddon) must:

  1. In the default sidecar path (no MYELIN_COPILOT_HEADROOM_PORT set),
     NEVER rewrite `flow.request.host`, `flow.request.port`, or
     `flow.request.scheme`. mitmproxy forwards the (body-modified) request
     to the ORIGINAL destination.

  2. Call headroom `/v1/compress` at the local sidecar port (default 8787),
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
http_stub.Response = types.SimpleNamespace(make=lambda *a, **k: None)
sys.modules['mitmproxy'] = mitmproxy_stub
sys.modules['mitmproxy.http'] = http_stub

# Force clean env — no redirect path, no cache/tool-filter interference.
os.environ.pop('MYELIN_COPILOT_HEADROOM_PORT', None)
os.environ['MYELIN_THRASH_CACHE'] = '0'
os.environ['MYELIN_LOG_SAVINGS'] = '0'
os.environ['MYELIN_TOOL_FILTER'] = '0'
os.environ['MYELIN_RAG_INJECT'] = '0'

# Re-import addon fresh (env-based constants read at import time).
if 'copilot_addon' in sys.modules:
    del sys.modules['copilot_addon']

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'src', 'mitm'))
import copilot_addon  # noqa: E402
from copilot_addon import MyelinAddon  # noqa: E402


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
