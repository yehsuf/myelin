"""Integration tests for copilot_addon.py <-> serena_context wiring.

Verifies:
  * inject_serena_context is called before tool_filter
  * tools[] contents/order unchanged after injection
  * MYELIN_RAG_INJECT + MYELIN_SERENA_CONTEXT double-injection is guarded
    (rag_injector.inject_rag_context NOT called when SERENA_CONTEXT is on)
"""
import copy
import json
import os
import sys
import types

# Stub mitmproxy before importing addon.
mitmproxy_stub = types.ModuleType('mitmproxy')
mitmproxy_stub.ctx = types.SimpleNamespace(log=types.SimpleNamespace(
    info=lambda *a, **k: None, warn=lambda *a, **k: None,
    debug=lambda *a, **k: None, error=lambda *a, **k: None,
))
http_stub = types.ModuleType('mitmproxy.http')
http_stub.HTTPFlow = object
http_stub.Response = types.SimpleNamespace(make=lambda *a, **k: None)
sys.modules['mitmproxy'] = mitmproxy_stub
sys.modules['mitmproxy.http'] = http_stub

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'src', 'mitm'))

import copilot_addon  # noqa: E402
import serena_context  # noqa: E402


# ---------------------------------------------------------------------------
# Fake flow helpers
# ---------------------------------------------------------------------------

class _FakeHeaders(dict):
    def get(self, key, default=None):
        for k, v in self.items():
            if k.lower() == key.lower():
                return v
        return default

    def pop(self, key, default=None):
        for k in list(self.keys()):
            if k.lower() == key.lower():
                return super().pop(k)
        return default

    def __setitem__(self, key, value):
        for k in list(self.keys()):
            if k.lower() == key.lower():
                del self[k]
        super().__setitem__(key, value)


class _FakeRequest:
    def __init__(self, host, path, body, method='POST'):
        self.pretty_host = host
        self.path = path
        self.method = method
        self.content = body
        self.headers = _FakeHeaders({'content-type': 'application/json'})


class _FakeClientConn:
    def __init__(self, port=8080):
        self.sockname = ('127.0.0.1', port)


class _FakeFlow:
    def __init__(self, host, path, body, method='POST'):
        self.request = _FakeRequest(host, path, body, method)
        self.client_conn = _FakeClientConn()
        self.response = None
        self.metadata: dict = {}


def _make_body(messages, tools=None, model='claude-3-5-sonnet'):
    d = {'model': model, 'messages': messages}
    if tools is not None:
        d['tools'] = tools
    return json.dumps(d).encode()


def _default_messages():
    return [
        {'role': 'user', 'content': 'find TokenBudget in this repo'},
    ]


def _default_tools():
    return [
        {'name': 'read_file', 'description': 'read a file'},
        {'name': 'edit_file', 'description': 'edit a file'},
        {'name': 'run_shell', 'description': 'run shell'},
    ]


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------

def _run_request(monkeypatch, *, serena_on, rag_on,
                 inject_serena_impl=None, inject_rag_impl=None,
                 filter_tools_impl=None):
    monkeypatch.setattr(copilot_addon, 'SERENA_CONTEXT', serena_on)
    monkeypatch.setattr(copilot_addon, 'RAG_INJECT', rag_on)
    monkeypatch.setattr(copilot_addon, 'TOOL_FILTER', True)
    monkeypatch.setattr(copilot_addon, 'THRASH_CACHE', False)
    monkeypatch.setattr(copilot_addon, 'COMPRESS', True)
    monkeypatch.setattr(copilot_addon, 'COPILOT_HEADROOM_PORT', None)
    # Neutralize compression so we can inspect the final body directly.
    monkeypatch.setattr(
        copilot_addon, '_compress_messages',
        lambda messages, fmt, model: (messages, 0, 0),
    )

    calls = {'serena': 0, 'rag': 0, 'tool_filter_tools': None,
             'tool_filter_tools_at_call': None,
             'serena_saw_tools': None}

    def _default_serena(data, fmt):
        calls['serena'] += 1
        calls['serena_saw_tools'] = copy.deepcopy(data.get('tools'))
        return data, {'injected': False}

    def _default_rag(data):
        calls['rag'] += 1
        return data

    def _default_filter(tools, messages):
        calls['tool_filter_tools_at_call'] = copy.deepcopy(tools)
        return list(tools), False

    # Install modules under the names the addon imports.
    fake_sc = types.ModuleType('serena_context')
    fake_sc.inject_serena_context = inject_serena_impl or _default_serena
    monkeypatch.setitem(sys.modules, 'serena_context', fake_sc)

    fake_rag = types.ModuleType('rag_injector')
    fake_rag.inject_rag_context = inject_rag_impl or _default_rag
    monkeypatch.setitem(sys.modules, 'rag_injector', fake_rag)

    fake_tf = types.ModuleType('tool_filter')
    fake_tf.filter_tools = filter_tools_impl or _default_filter
    monkeypatch.setitem(sys.modules, 'tool_filter', fake_tf)

    body = _make_body(_default_messages(), tools=_default_tools())
    flow = _FakeFlow('api.anthropic.com', '/v1/messages', body)

    addon = copilot_addon.MyelinAddon()
    addon.request(flow)

    # Read back mutated request body if it was changed
    final_body = flow.request.content
    try:
        final_data = json.loads(final_body)
    except Exception:
        final_data = None
    return calls, final_data, flow


def test_serena_called_before_tool_filter(monkeypatch):
    order: list[str] = []

    def _serena(data, fmt):
        order.append('serena')
        return data, {'injected': False}

    def _filter(tools, messages):
        order.append('tool_filter')
        return list(tools), False

    _run_request(monkeypatch, serena_on=True, rag_on=False,
                 inject_serena_impl=_serena, filter_tools_impl=_filter)
    assert order == ['serena', 'tool_filter']


def test_serena_sees_original_tools_unchanged(monkeypatch):
    tools_orig = _default_tools()
    called = {'n': 0}

    def _serena(data, fmt):
        called['n'] += 1
        # tools[] must be present and untouched at this stage
        assert data.get('tools') == tools_orig
        return data, {'injected': False}

    _run_request(
        monkeypatch, serena_on=True, rag_on=False,
        inject_serena_impl=_serena,
    )
    assert called['n'] == 1


def test_tools_order_and_contents_preserved_after_injection(monkeypatch):
    tools_orig = _default_tools()

    def _serena(data, fmt):
        # Simulate a real injection: append a text block to last user message.
        new_data = dict(data)
        new_messages = list(new_data['messages'])
        last = dict(new_messages[-1])
        last['content'] = last['content'] + '\n\n<myelin_serena_context>...ctx...</myelin_serena_context>'
        new_messages[-1] = last
        new_data['messages'] = new_messages
        return new_data, {'injected': True, 'snippet_count': 2, 'frozen_count': 0}

    # Passthrough tool_filter to verify what tools[] look like at that point.
    seen_tools = {'val': None}

    def _filter(tools, messages):
        seen_tools['val'] = copy.deepcopy(tools)
        return list(tools), False

    calls, final_data, _flow = _run_request(
        monkeypatch, serena_on=True, rag_on=False,
        inject_serena_impl=_serena, filter_tools_impl=_filter,
    )
    assert seen_tools['val'] == tools_orig
    # tool_filter returned tools unchanged; final data should still hold them.
    assert final_data['tools'] == tools_orig
    # Injection landed in the last user message
    assert '<myelin_serena_context>' in final_data['messages'][-1]['content']


def test_double_injection_guard_rag_skipped_when_serena_on(monkeypatch):
    calls, _final, _flow = _run_request(
        monkeypatch, serena_on=True, rag_on=True,
    )
    assert calls['serena'] == 1
    assert calls['rag'] == 0


def test_rag_still_runs_when_serena_off(monkeypatch):
    calls, _final, _flow = _run_request(
        monkeypatch, serena_on=False, rag_on=True,
    )
    assert calls['serena'] == 0
    assert calls['rag'] == 1


def test_neither_runs_when_both_off(monkeypatch):
    calls, _final, _flow = _run_request(
        monkeypatch, serena_on=False, rag_on=False,
    )
    assert calls['serena'] == 0
    assert calls['rag'] == 0


def test_serena_exception_does_not_break_flow(monkeypatch):
    def _boom(data, fmt):
        raise RuntimeError('serena exploded')

    filter_called = {'n': 0}

    def _filter(tools, messages):
        filter_called['n'] += 1
        return list(tools), False

    _run_request(
        monkeypatch, serena_on=True, rag_on=False,
        inject_serena_impl=_boom, filter_tools_impl=_filter,
    )
    # tool_filter still runs after serena_context error (fail open)
    assert filter_called['n'] == 1


def test_end_to_end_with_real_serena_context(monkeypatch, tmp_path):
    """Wire the actual serena_context module in and verify mutation."""
    # Force real module (not the fake one). Undo the fake by re-importing.
    monkeypatch.setitem(sys.modules, 'serena_context', serena_context)

    monkeypatch.setattr(copilot_addon, 'SERENA_CONTEXT', True)
    monkeypatch.setattr(copilot_addon, 'RAG_INJECT', False)
    monkeypatch.setattr(copilot_addon, 'TOOL_FILTER', False)
    monkeypatch.setattr(copilot_addon, 'THRASH_CACHE', False)
    monkeypatch.setattr(copilot_addon, 'COMPRESS', True)
    monkeypatch.setattr(copilot_addon, 'COPILOT_HEADROOM_PORT', None)
    monkeypatch.setattr(
        copilot_addon, '_compress_messages',
        lambda messages, fmt, model: (messages, 0, 0),
    )

    # Force serena_search to fail and fallback to return snippets.
    monkeypatch.setattr(serena_context, 'serena_search', lambda q, w: [])
    monkeypatch.setattr(
        serena_context, 'fallback_rg_search',
        lambda q, w: [{'file': 'a.py', 'snippet': 'class TokenBudget: ...'}],
    )
    monkeypatch.setattr(serena_context, 'detect_workspace', lambda d, m: tmp_path)

    body = _make_body(_default_messages(), tools=_default_tools())
    flow = _FakeFlow('api.anthropic.com', '/v1/messages', body)
    copilot_addon.MyelinAddon().request(flow)

    final = json.loads(flow.request.content)
    # tools[] unchanged
    assert final['tools'] == _default_tools()
    # last user got context appended
    last = final['messages'][-1]
    assert isinstance(last['content'], str)
    assert '<myelin_serena_context>' in last['content']
    assert 'class TokenBudget' in last['content']
