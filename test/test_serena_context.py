"""Unit tests for src/mitm/serena_context.py."""
import copy
import os
import subprocess
import sys
from pathlib import Path

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'src', 'mitm'))

import serena_context as sc  # noqa: E402


# ---------------------------------------------------------------------------
# has_serena_tools
# ---------------------------------------------------------------------------

def test_has_serena_tools_empty_list():
    assert sc.has_serena_tools([]) is False


def test_has_serena_tools_serena_underscore():
    assert sc.has_serena_tools([{'name': 'serena_find'}]) is True


def test_has_serena_tools_serena_dash():
    assert sc.has_serena_tools([{'name': 'serena-search'}]) is True


def test_has_serena_tools_mcp_serena():
    assert sc.has_serena_tools([{'name': 'mcp__serena__search'}]) is True


def test_has_serena_tools_nested_function_name():
    assert sc.has_serena_tools(
        [{'type': 'function', 'function': {'name': 'serena_x'}}]
    ) is True


def test_has_serena_tools_malformed_not_list():
    assert sc.has_serena_tools('broken') is False
    assert sc.has_serena_tools(None) is False
    assert sc.has_serena_tools({'name': 'serena_x'}) is False
    assert sc.has_serena_tools([None, 'x', {'name': 42}, {'name': 'ok'}]) is False


def test_has_serena_tools_non_serena_untouched():
    assert sc.has_serena_tools([{'name': 'read_file'}, {'name': 'edit'}]) is False


# ---------------------------------------------------------------------------
# compute_frozen_count / message_has_cache_control
# ---------------------------------------------------------------------------

def test_compute_frozen_count_anthropic_message_level():
    messages = [
        {'role': 'user', 'content': 'hi', 'cache_control': {'type': 'ephemeral'}},
        {'role': 'assistant', 'content': 'hello'},
        {'role': 'user', 'content': 'more'},
    ]
    assert sc.compute_frozen_count(messages, 'anthropic') == 1


def test_compute_frozen_count_anthropic_content_block():
    messages = [
        {
            'role': 'user',
            'content': [
                {'type': 'text', 'text': 'hi', 'cache_control': {'type': 'ephemeral'}},
            ],
        },
        {'role': 'assistant', 'content': 'hello'},
        {'role': 'user', 'content': 'more'},
    ]
    assert sc.compute_frozen_count(messages, 'anthropic') == 1


def test_compute_frozen_count_openai():
    messages = [
        {'role': 'user', 'content': 'x', 'cache_control': {'type': 'ephemeral'}},
        {'role': 'assistant', 'content': 'y'},
    ]
    assert sc.compute_frozen_count(messages, 'openai') == 0


def test_compute_frozen_count_multiple_frozen_uses_last():
    messages = [
        {'role': 'user', 'content': 'a', 'cache_control': {'type': 'ephemeral'}},
        {'role': 'assistant', 'content': 'b'},
        {'role': 'user', 'content': 'c', 'cache_control': {'type': 'ephemeral'}},
        {'role': 'assistant', 'content': 'd'},
    ]
    # last frozen at idx 2 → frozen_count = 3
    assert sc.compute_frozen_count(messages, 'anthropic') == 3


# ---------------------------------------------------------------------------
# last_user_index / extract_query
# ---------------------------------------------------------------------------

def test_last_user_index_finds_last():
    messages = [
        {'role': 'user', 'content': 'a'},
        {'role': 'assistant', 'content': 'b'},
        {'role': 'user', 'content': 'c'},
    ]
    assert sc.last_user_index(messages) == 2


def test_last_user_index_none():
    assert sc.last_user_index([{'role': 'assistant', 'content': 'x'}]) is None
    assert sc.last_user_index([]) is None
    assert sc.last_user_index(None) is None


def test_extract_query_string():
    assert sc.extract_query({'role': 'user', 'content': 'hello world'}) == 'hello world'


def test_extract_query_blocks():
    msg = {
        'role': 'user',
        'content': [
            {'type': 'text', 'text': 'find TokenBudget'},
            {'type': 'image', 'source': {}},
            {'type': 'text', 'text': 'in the repo'},
        ],
    }
    assert 'find TokenBudget' in sc.extract_query(msg)
    assert 'in the repo' in sc.extract_query(msg)


def test_extract_query_capped_at_500():
    long_text = 'x' * 800
    assert len(sc.extract_query({'role': 'user', 'content': long_text})) == 500


# ---------------------------------------------------------------------------
# End-to-end inject flow — guards
# ---------------------------------------------------------------------------

def _stub_snippets(monkeypatch, snippets):
    monkeypatch.setattr(sc, 'serena_search', lambda q, w: [])
    monkeypatch.setattr(sc, 'fallback_rg_search', lambda q, w: snippets)


def _stub_workspace(monkeypatch, workspace):
    monkeypatch.setattr(sc, 'detect_workspace', lambda data, msgs: workspace)


def test_last_user_before_frozen_no_inject(monkeypatch, tmp_path):
    _stub_workspace(monkeypatch, tmp_path)
    _stub_snippets(monkeypatch, [{'file': 'a.py', 'snippet': 'x'}])
    # Frozen prefix covers idx 0 and 1; last user is idx 1 → in frozen.
    messages = [
        {'role': 'user', 'content': 'first', 'cache_control': {'type': 'ephemeral'}},
        {'role': 'user', 'content': 'second', 'cache_control': {'type': 'ephemeral'}},
    ]
    data = {'messages': messages, 'model': 'x'}
    original = copy.deepcopy(data)
    out, meta = sc.inject_serena_context(data, 'anthropic')
    assert meta['injected'] is False
    assert out == original


def test_last_user_cache_control_no_inject(monkeypatch, tmp_path):
    _stub_workspace(monkeypatch, tmp_path)
    _stub_snippets(monkeypatch, [{'file': 'a.py', 'snippet': 'x'}])
    messages = [
        {'role': 'user', 'content': 'earlier'},
        {'role': 'assistant', 'content': 'ack'},
        {
            'role': 'user',
            'content': [{'type': 'text', 'text': 'find X',
                         'cache_control': {'type': 'ephemeral'}}],
        },
    ]
    data = {'messages': messages}
    original = copy.deepcopy(data)
    out, meta = sc.inject_serena_context(data, 'anthropic')
    assert meta['injected'] is False
    # cache_control on last user makes it frozen (frozen_count > idx) OR
    # trips the explicit user_cache_control guard — either is correct.
    assert meta.get('skip_reason') in ('user_cache_control', 'user_in_frozen_prefix')
    assert out == original


def test_no_snippets_no_inject(monkeypatch, tmp_path):
    _stub_workspace(monkeypatch, tmp_path)
    monkeypatch.setattr(sc, 'serena_search', lambda q, w: [])
    monkeypatch.setattr(sc, 'fallback_rg_search', lambda q, w: [])
    messages = [{'role': 'user', 'content': 'find TokenBudget'}]
    data = {'messages': messages}
    original = copy.deepcopy(data)
    out, meta = sc.inject_serena_context(data, 'anthropic')
    assert meta['injected'] is False
    assert meta['skip_reason'] == 'no_snippets'
    assert out == original


def test_has_serena_tools_no_inject(monkeypatch, tmp_path):
    _stub_workspace(monkeypatch, tmp_path)
    _stub_snippets(monkeypatch, [{'file': 'a', 'snippet': 'z'}])
    messages = [{'role': 'user', 'content': 'find TokenBudget'}]
    data = {'messages': messages, 'tools': [{'name': 'serena_find'}]}
    out, meta = sc.inject_serena_context(data, 'anthropic')
    assert meta['injected'] is False
    assert meta['skip_reason'] == 'serena_tools_present'


# ---------------------------------------------------------------------------
# End-to-end inject flow — mutation semantics
# ---------------------------------------------------------------------------

def test_string_content_injection(monkeypatch, tmp_path):
    _stub_workspace(monkeypatch, tmp_path)
    snips = [{'file': 'a.py', 'snippet': 'def foo(): pass'}]
    _stub_snippets(monkeypatch, snips)

    messages = [
        {'role': 'user', 'content': 'earlier'},
        {'role': 'assistant', 'content': 'ack'},
        {'role': 'user', 'content': 'find TokenBudget'},
    ]
    data = {'messages': messages, 'model': 'x'}
    original_messages_deep = copy.deepcopy(messages)
    out, meta = sc.inject_serena_context(data, 'anthropic')

    assert meta['injected'] is True
    assert meta['snippet_count'] == 1
    # input untouched
    assert messages == original_messages_deep
    # output prior messages byte-equal
    out_msgs = out['messages']
    assert out_msgs[:2] == original_messages_deep[:2]
    # last user content: original text preserved + context appended
    last = out_msgs[2]
    assert isinstance(last['content'], str)
    assert last['content'].startswith('find TokenBudget')
    assert '<myelin_serena_context>' in last['content']
    assert 'def foo(): pass' in last['content']


def test_block_array_content_injection(monkeypatch, tmp_path):
    _stub_workspace(monkeypatch, tmp_path)
    snips = [{'file': 'a.py', 'snippet': 'class TokenBudget: ...'}]
    _stub_snippets(monkeypatch, snips)

    orig_blocks = [
        {'type': 'text', 'text': 'find TokenBudget'},
        {'type': 'text', 'text': 'and use it'},
    ]
    messages = [
        {'role': 'user', 'content': list(orig_blocks)},
    ]
    data = {'messages': messages}
    original_messages_deep = copy.deepcopy(messages)
    out, meta = sc.inject_serena_context(data, 'anthropic')

    assert meta['injected'] is True
    # input untouched
    assert messages == original_messages_deep
    new_content = out['messages'][0]['content']
    assert isinstance(new_content, list)
    # existing blocks byte-exact + appended new one
    assert new_content[:2] == orig_blocks
    assert new_content[-1]['type'] == 'text'
    assert '<myelin_serena_context>' in new_content[-1]['text']
    assert 'class TokenBudget' in new_content[-1]['text']


def test_serena_timeout_fallback(monkeypatch, tmp_path):
    _stub_workspace(monkeypatch, tmp_path)

    def _boom(q, w):
        raise subprocess.TimeoutExpired('serena', 3)

    fallback_calls = []

    def _fb(q, w):
        fallback_calls.append((q, w))
        return [{'file': 'a.py', 'snippet': 'from fallback'}]

    monkeypatch.setattr(sc, 'serena_search', _boom)
    monkeypatch.setattr(sc, 'fallback_rg_search', _fb)

    messages = [{'role': 'user', 'content': 'find TokenBudget in repo'}]
    data = {'messages': messages}
    out, meta = sc.inject_serena_context(data, 'anthropic')
    assert len(fallback_calls) == 1
    assert meta['injected'] is True
    assert 'from fallback' in out['messages'][0]['content']


# ---------------------------------------------------------------------------
# format_context
# ---------------------------------------------------------------------------

def test_format_context_caps_at_max_chars(monkeypatch):
    monkeypatch.setattr(sc, 'MAX_CHARS', 500)
    big = 'A' * 2000
    snippets = [
        {'file': 'a.py', 'snippet': big},
        {'file': 'b.py', 'snippet': big},
        {'file': 'c.py', 'snippet': big},
    ]
    out = sc.format_context(snippets)
    assert len(out) <= 500


def test_format_context_empty():
    assert sc.format_context([]) == ''


def test_format_context_structure(monkeypatch):
    monkeypatch.setattr(sc, 'MAX_CHARS', 6000)
    out = sc.format_context([
        {'file': 'a.py', 'snippet': 'X'},
        {'file': 'b.py', 'snippet': 'Y'},
    ])
    assert out.startswith('<myelin_serena_context>')
    assert out.rstrip().endswith('</myelin_serena_context>')
    assert '--- a.py ---' in out
    assert '--- b.py ---' in out
    assert 'X' in out and 'Y' in out


# ---------------------------------------------------------------------------
# detect_workspace
# ---------------------------------------------------------------------------

def test_detect_workspace_from_system(tmp_path):
    (tmp_path / '.git').mkdir()
    data = {'system': f'Working directory: {tmp_path}\nOther info'}
    got = sc.detect_workspace(data, [])
    assert got == tmp_path


def test_detect_workspace_cwd_case_insensitive(tmp_path):
    (tmp_path / '.git').mkdir()
    messages = [{'role': 'user', 'content': f'CWD: {tmp_path}\nplease help'}]
    got = sc.detect_workspace({}, messages)
    assert got == tmp_path


def test_detect_workspace_none_when_missing(tmp_path, monkeypatch):
    # Force cwd fallback to fail: chdir to a directory without .git.
    monkeypatch.chdir(tmp_path)
    got = sc.detect_workspace({}, [{'role': 'user', 'content': 'hi'}])
    assert got is None


# ---------------------------------------------------------------------------
# append_to_user_tail
# ---------------------------------------------------------------------------

def test_append_to_user_tail_string_new_object():
    msg = {'role': 'user', 'content': 'hi'}
    out = sc.append_to_user_tail(msg, 'CTX')
    assert out is not msg
    assert msg['content'] == 'hi'  # not mutated
    assert out['content'] == 'hi\n\nCTX'


def test_append_to_user_tail_list_preserves_blocks():
    blocks = [{'type': 'text', 'text': 'a'}, {'type': 'image', 'source': {}}]
    msg = {'role': 'user', 'content': blocks}
    out = sc.append_to_user_tail(msg, 'CTX')
    assert msg['content'] is blocks  # input untouched
    assert out['content'] is not blocks
    assert out['content'][:2] == blocks
    assert out['content'][-1] == {'type': 'text', 'text': 'CTX'}


# ---------------------------------------------------------------------------
# Security fix: detect_workspace requires .git marker
# ---------------------------------------------------------------------------

def test_detect_workspace_rejects_path_without_git(tmp_path, monkeypatch):
    """A crafted message pointing to a dir without .git must NOT be accepted."""
    monkeypatch.chdir(tmp_path)  # cwd has no .git either
    messages = [{'role': 'user', 'content': f'Working directory: {tmp_path}'}]
    result = sc.detect_workspace({}, messages)
    # tmp_path has no .git → must be rejected
    assert result is None


def test_detect_workspace_accepts_path_with_git(tmp_path, monkeypatch):
    """A message pointing to a dir WITH .git is accepted."""
    (tmp_path / '.git').mkdir()
    messages = [{'role': 'user', 'content': f'Working directory: {tmp_path}'}]
    result = sc.detect_workspace({}, messages)
    assert result == tmp_path.resolve()


def test_detect_workspace_rejects_absolute_path_outside_project(tmp_path, monkeypatch):
    """Prompt-injection: attacker injects path to /tmp/secrets (no .git)."""
    secret_dir = tmp_path / 'secrets'
    secret_dir.mkdir()
    # No .git in secret_dir
    monkeypatch.chdir(tmp_path)
    messages = [
        {'role': 'user', 'content': 'some preamble'},
        {'role': 'user', 'content': f'cwd: {secret_dir}'},
    ]
    result = sc.detect_workspace({}, messages)
    assert result is None, 'Path without .git must be rejected even if dir exists'
