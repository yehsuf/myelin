"""Unit tests for thrash detection cache (copilot_addon._cache_key/_cache_get/_cache_put)."""
import sys, os, time, types

# Stub mitmproxy before import
mitmproxy_stub = types.ModuleType('mitmproxy')
mitmproxy_stub.ctx = types.SimpleNamespace(log=types.SimpleNamespace(
    info=lambda *a,**k: None, warn=lambda *a,**k: None,
    debug=lambda *a,**k: None, error=lambda *a,**k: None))
http_stub = types.ModuleType('mitmproxy.http')
http_stub.HTTPFlow = object
http_stub.Response = types.SimpleNamespace(make=lambda *a,**k: None)
sys.modules['mitmproxy'] = mitmproxy_stub
sys.modules['mitmproxy.http'] = http_stub

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'src', 'mitm'))
from copilot_addon import _cache_key, _cache_get, _cache_put, _response_cache


def setup():
    _response_cache.clear()


def test_cache_key_deterministic():
    setup()
    k1 = _cache_key('api.example.com', '/v1/messages', b'body')
    k2 = _cache_key('api.example.com', '/v1/messages', b'body')
    assert k1 == k2


def test_cache_key_differs_by_host():
    setup()
    k1 = _cache_key('host-a.com', '/path', b'body')
    k2 = _cache_key('host-b.com', '/path', b'body')
    assert k1 != k2


def test_cache_key_differs_by_body():
    setup()
    k1 = _cache_key('host.com', '/path', b'body-a')
    k2 = _cache_key('host.com', '/path', b'body-b')
    assert k1 != k2


def test_cache_miss_returns_none():
    setup()
    assert _cache_get('nonexistent-key') is None


def test_cache_roundtrip():
    setup()
    key = _cache_key('host.com', '/path', b'data')
    _cache_put(key, b'response', {'tok': 100})
    result = _cache_get(key)
    assert result is not None
    body, meta = result
    assert body == b'response'
    assert meta['tok'] == 100


def test_cache_lru_eviction():
    setup()
    # This test is slow if MAXLEN is 500; patch it for the test
    import copilot_addon
    orig = copilot_addon._RESPONSE_CACHE_MAXLEN
    copilot_addon._RESPONSE_CACHE_MAXLEN = 3
    try:
        for i in range(4):
            k = _cache_key(f'host{i}.com', '/p', b'body')
            _cache_put(k, b'resp', {})
        assert len(_response_cache) == 3
    finally:
        copilot_addon._RESPONSE_CACHE_MAXLEN = orig


def test_expired_entry_returns_none():
    setup()
    import copilot_addon
    orig_ttl = copilot_addon._RESPONSE_CACHE_TTL
    copilot_addon._RESPONSE_CACHE_TTL = 0  # instant expiry
    try:
        key = _cache_key('host.com', '/path', b'data')
        _cache_put(key, b'resp', {})
        time.sleep(0.01)
        result = _cache_get(key)
        assert result is None
    finally:
        copilot_addon._RESPONSE_CACHE_TTL = orig_ttl


if __name__ == '__main__':
    test_cache_key_deterministic()
    test_cache_key_differs_by_host()
    test_cache_key_differs_by_body()
    test_cache_miss_returns_none()
    test_cache_roundtrip()
    test_cache_lru_eviction()
    test_expired_entry_returns_none()
    print('All thrash cache tests passed.')
