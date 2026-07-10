"""Unit tests for copilot_addon.scrub_log_str and scrub_headers_for_log."""
import os
import sys
import types

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'src', 'mitm'))

mitmproxy_stub = types.ModuleType('mitmproxy')
mitmproxy_stub.ctx = types.SimpleNamespace(
    log=types.SimpleNamespace(info=print, warn=print, debug=print, error=print)
)
http_stub = types.ModuleType('mitmproxy.http')
http_stub.HTTPFlow = object
sys.modules['mitmproxy'] = mitmproxy_stub
sys.modules['mitmproxy.http'] = http_stub

from copilot_addon import scrub_headers_for_log, scrub_log_str


def test_bearer_token_redacted():
    s = 'Authorization: Bearer ghp_abcdef1234567890xyz'
    result = scrub_log_str(s)
    assert '[REDACTED]' in result
    assert 'ghp_abcdef' not in result


def test_api_key_header_redacted():
    s = 'X-Api-Key: sk-1234567890abcdef'
    result = scrub_log_str(s)
    assert '[REDACTED]' in result
    assert 'sk-1234' not in result


def test_ghp_token_in_url_redacted():
    s = 'error connecting to https://ghp_abc123def456@api.github.com'
    result = scrub_log_str(s)
    assert 'ghp_abc123def456' not in result


def test_safe_string_unchanged():
    s = '[myelin] tools 5→3'
    assert scrub_log_str(s) == s


def test_scrub_headers_redacts_authorization():
    headers = {'Authorization': 'Bearer secret123', 'Content-Type': 'application/json'}
    result = scrub_headers_for_log(headers)
    assert result['Authorization'] == '[REDACTED]'
    assert result['Content-Type'] == 'application/json'


def test_scrub_headers_case_insensitive():
    headers = {'authorization': 'Bearer secret', 'X-API-KEY': 'mykey'}
    result = scrub_headers_for_log(headers)
    assert result['authorization'] == '[REDACTED]'
    assert result['X-API-KEY'] == '[REDACTED]'


def test_scrub_headers_empty():
    assert scrub_headers_for_log({}) == {}


if __name__ == '__main__':
    test_bearer_token_redacted()
    test_api_key_header_redacted()
    test_ghp_token_in_url_redacted()
    test_safe_string_unchanged()
    test_scrub_headers_redacts_authorization()
    test_scrub_headers_case_insensitive()
    test_scrub_headers_empty()
    print('All tests passed.')
