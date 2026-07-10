"""Unit tests for src/mitm/rag_injector.py — 91 test cases.

Covers:
  A. _is_serena_running (psutil path)      1-8
  B. _is_serena_running (Windows fallback) 9-16
  C. _is_serena_running (POSIX fallback)   17-21
  D. _has_serena_tools                     22-28
  E. _detect_workspace                     29-38
  F. _extract_query                        39-43
  G. _extract_keywords                     44-50
  H. _rg_available / _rg_search            51-58
  I. _py_grep / _read_snippet              59-67
  J. _serena_search                        68-76
  K. Public API                            77-91
"""
import json
import os
import subprocess
import sys
import types
from pathlib import Path

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'src', 'mitm'))
import rag_injector as ri  # noqa: E402


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

class _FakeProc:
    """Fake psutil Process — exposes .info dict."""
    def __init__(self, cmdline):
        self.info = {'cmdline': cmdline}


class _FakePsutilProcess:
    """Fake psutil Process that raises on .info access."""
    def __init__(self, exc):
        self._exc = exc

    @property
    def info(self):
        raise self._exc


class _FakeNoSuchProcess(Exception):
    pass


class _FakeAccessDenied(Exception):
    pass


def _install_fake_psutil(monkeypatch, processes):
    """Inject a fake psutil module into sys.modules for the current test."""
    fake = types.ModuleType('psutil')
    fake.NoSuchProcess = _FakeNoSuchProcess
    fake.AccessDenied = _FakeAccessDenied

    def process_iter(attrs=None):
        for p in processes:
            yield p

    fake.process_iter = process_iter
    monkeypatch.setitem(sys.modules, 'psutil', fake)


def _remove_psutil(monkeypatch):
    """Ensure `import psutil` raises ImportError inside the function under test."""
    # psutil isn't installed in the test env, but be defensive in case a
    # prior test left a stub.
    monkeypatch.delitem(sys.modules, 'psutil', raising=False)
    # Also block re-import via a finder that always raises ImportError.
    class _BlockPsutil:
        def find_spec(self, name, path, target=None):
            if name == 'psutil':
                raise ImportError('blocked')
            return None
    finder = _BlockPsutil()
    monkeypatch.setattr(sys, 'meta_path', [finder] + sys.meta_path)


def _fake_run(stdout='', stderr='', returncode=0, raise_exc=None):
    """Build a subprocess.run replacement that records args and returns a
    fake CompletedProcess."""
    calls = []

    def fake(cmd, **kwargs):
        calls.append({'cmd': cmd, 'kwargs': kwargs})
        if raise_exc is not None:
            raise raise_exc
        return types.SimpleNamespace(
            stdout=stdout if isinstance(stdout, (str, bytes)) else stdout,
            stderr=stderr,
            returncode=returncode,
        )
    fake.calls = calls
    return fake


def setup_function(function):
    """Reset module-level cached state before every test."""
    ri._RG_OK = None


# ---------------------------------------------------------------------------
# GROUP A — _is_serena_running with psutil (1-8)
# ---------------------------------------------------------------------------

def test_01_psutil_found_exact_name(monkeypatch):
    _install_fake_psutil(monkeypatch, [_FakeProc(['serena'])])
    assert ri._is_serena_running() is True


def test_02_psutil_found_uvx_python(monkeypatch):
    _install_fake_psutil(monkeypatch, [
        _FakeProc(['python.exe', '-m', 'serena_agent', 'start']),
    ])
    assert ri._is_serena_running() is True


def test_03_psutil_case_insensitive(monkeypatch):
    _install_fake_psutil(monkeypatch, [_FakeProc(['Serena-Agent'])])
    assert ri._is_serena_running() is True


def test_04_psutil_no_match(monkeypatch):
    _install_fake_psutil(monkeypatch, [_FakeProc(['bash']), _FakeProc(['python', 'other'])])
    assert ri._is_serena_running() is False


def test_05_psutil_empty_process_list(monkeypatch):
    _install_fake_psutil(monkeypatch, [])
    assert ri._is_serena_running() is False


def test_06_psutil_no_such_process_continues(monkeypatch):
    _install_fake_psutil(monkeypatch, [
        _FakePsutilProcess(_FakeNoSuchProcess()),
        _FakeProc(['serena-agent']),
    ])
    assert ri._is_serena_running() is True


def test_07_psutil_access_denied_continues(monkeypatch):
    _install_fake_psutil(monkeypatch, [
        _FakePsutilProcess(_FakeAccessDenied()),
        _FakeProc(['nothing_here']),
    ])
    assert ri._is_serena_running() is False


def test_08_psutil_cmdline_none(monkeypatch):
    _install_fake_psutil(monkeypatch, [_FakeProc(None)])
    assert ri._is_serena_running() is False


# ---------------------------------------------------------------------------
# GROUP B — Windows fallback (no psutil) (9-16)
# ---------------------------------------------------------------------------

def test_09_windows_powershell_found(monkeypatch):
    _remove_psutil(monkeypatch)
    monkeypatch.setattr('platform.system', lambda: 'Windows')
    fake = _fake_run(stdout='FOUND\n', returncode=0)
    monkeypatch.setattr(ri.subprocess, 'run', fake)
    assert ri._is_serena_running() is True
    assert len(fake.calls) == 1
    call = fake.calls[0]
    assert call['cmd'][0:4] == ['powershell', '-NoProfile', '-NonInteractive', '-Command']
    script = call['cmd'][4]
    assert 'Get-CimInstance' in script
    assert "CommandLine LIKE '%serena%'" in script


def test_10_windows_powershell_none(monkeypatch):
    _remove_psutil(monkeypatch)
    monkeypatch.setattr('platform.system', lambda: 'Windows')
    monkeypatch.setattr(ri.subprocess, 'run', _fake_run(stdout='NONE\n'))
    assert ri._is_serena_running() is False


def test_11_windows_empty_stdout(monkeypatch):
    _remove_psutil(monkeypatch)
    monkeypatch.setattr('platform.system', lambda: 'Windows')
    monkeypatch.setattr(ri.subprocess, 'run', _fake_run(stdout=''))
    assert ri._is_serena_running() is False


def test_12_windows_file_not_found(monkeypatch):
    _remove_psutil(monkeypatch)
    monkeypatch.setattr('platform.system', lambda: 'Windows')
    monkeypatch.setattr(ri.subprocess, 'run',
                        _fake_run(raise_exc=FileNotFoundError('powershell missing')))
    assert ri._is_serena_running() is False


def test_13_windows_timeout(monkeypatch):
    _remove_psutil(monkeypatch)
    monkeypatch.setattr('platform.system', lambda: 'Windows')
    monkeypatch.setattr(
        ri.subprocess, 'run',
        _fake_run(raise_exc=subprocess.TimeoutExpired(cmd='ps', timeout=5)),
    )
    assert ri._is_serena_running() is False


def test_14_windows_wmi_denied_returns_none(monkeypatch):
    # WMI access denied → SilentlyContinue → stdout='NONE' → False
    _remove_psutil(monkeypatch)
    monkeypatch.setattr('platform.system', lambda: 'Windows')
    monkeypatch.setattr(ri.subprocess, 'run', _fake_run(stdout='NONE\n'))
    assert ri._is_serena_running() is False


def test_15_windows_os_error(monkeypatch):
    _remove_psutil(monkeypatch)
    monkeypatch.setattr('platform.system', lambda: 'Windows')
    monkeypatch.setattr(ri.subprocess, 'run',
                        _fake_run(raise_exc=OSError('boom')))
    assert ri._is_serena_running() is False


def test_16_windows_command_shape(monkeypatch):
    _remove_psutil(monkeypatch)
    monkeypatch.setattr('platform.system', lambda: 'Windows')
    fake = _fake_run(stdout='NONE\n')
    monkeypatch.setattr(ri.subprocess, 'run', fake)
    ri._is_serena_running()
    call = fake.calls[0]
    assert call['cmd'][0:4] == ['powershell', '-NoProfile', '-NonInteractive', '-Command']
    assert 'Win32_Process' in call['cmd'][4]
    assert call['kwargs'].get('timeout') == 5


# ---------------------------------------------------------------------------
# GROUP C — POSIX fallback (no psutil) (17-21)
# ---------------------------------------------------------------------------

def test_17_pgrep_found(monkeypatch):
    _remove_psutil(monkeypatch)
    monkeypatch.setattr('platform.system', lambda: 'Linux')
    fake = _fake_run(stdout=b'12345\n', returncode=0)
    monkeypatch.setattr(ri.subprocess, 'run', fake)
    assert ri._is_serena_running() is True
    assert fake.calls[0]['cmd'] == ['pgrep', '-f', 'serena']


def test_18_pgrep_not_found(monkeypatch):
    _remove_psutil(monkeypatch)
    monkeypatch.setattr('platform.system', lambda: 'Linux')
    monkeypatch.setattr(ri.subprocess, 'run', _fake_run(stdout=b'', returncode=1))
    assert ri._is_serena_running() is False


def test_19_pgrep_missing(monkeypatch):
    _remove_psutil(monkeypatch)
    monkeypatch.setattr('platform.system', lambda: 'Linux')
    monkeypatch.setattr(ri.subprocess, 'run',
                        _fake_run(raise_exc=FileNotFoundError()))
    assert ri._is_serena_running() is False


def test_20_pgrep_timeout(monkeypatch):
    _remove_psutil(monkeypatch)
    monkeypatch.setattr('platform.system', lambda: 'Linux')
    monkeypatch.setattr(
        ri.subprocess, 'run',
        _fake_run(raise_exc=subprocess.TimeoutExpired(cmd='pgrep', timeout=2)),
    )
    assert ri._is_serena_running() is False


def test_21_darwin_uses_pgrep(monkeypatch):
    _remove_psutil(monkeypatch)
    monkeypatch.setattr('platform.system', lambda: 'Darwin')
    fake = _fake_run(stdout=b'123\n', returncode=0)
    monkeypatch.setattr(ri.subprocess, 'run', fake)
    ri._is_serena_running()
    assert fake.calls[0]['cmd'] == ['pgrep', '-f', 'serena']


# ---------------------------------------------------------------------------
# GROUP D — _has_serena_tools (22-28)
# ---------------------------------------------------------------------------

def test_22_has_serena_empty():
    assert ri._has_serena_tools([]) is False


def test_23_has_serena_underscore():
    assert ri._has_serena_tools([{'name': 'serena_find_symbol'}]) is True


def test_24_has_serena_dash():
    assert ri._has_serena_tools([{'name': 'serena-find-symbol'}]) is True


def test_25_has_serena_oai_nested():
    assert ri._has_serena_tools(
        [{'function': {'name': 'serena_x'}}]
    ) is True


def test_26_has_serena_none():
    assert ri._has_serena_tools([{'name': 'Read'}, {'name': 'Bash'}]) is False


def test_27_has_serena_mixed():
    assert ri._has_serena_tools(
        [{'name': 'Read'}, {'name': 'serena_get'}]
    ) is True


def test_28_has_serena_missing_name_key():
    assert ri._has_serena_tools([{}]) is False


# ---------------------------------------------------------------------------
# GROUP E — _detect_workspace (29-38)
# ---------------------------------------------------------------------------

def test_29_detect_working_directory(tmp_path):
    msgs = [{'role': 'system', 'content': f'Working directory: {tmp_path}'}]
    assert ri._detect_workspace(msgs) == tmp_path


def test_30_detect_current_directory(tmp_path):
    msgs = [{'role': 'system', 'content': f'Current directory: {tmp_path}'}]
    assert ri._detect_workspace(msgs) == tmp_path


def test_31_detect_project_root(tmp_path):
    msgs = [{'role': 'system', 'content': f'Project root: {tmp_path}'}]
    assert ri._detect_workspace(msgs) == tmp_path


def test_32_detect_cwd_lowercase(tmp_path):
    msgs = [{'role': 'system', 'content': f'cwd: {tmp_path}'}]
    assert ri._detect_workspace(msgs) == tmp_path


def test_33_detect_list_content_type_text(tmp_path):
    msgs = [{'role': 'system', 'content': [
        {'type': 'text', 'text': f'Working directory: {tmp_path}'},
    ]}]
    assert ri._detect_workspace(msgs) == tmp_path


def test_34_detect_nonexistent_falls_through(tmp_path, monkeypatch):
    monkeypatch.setattr(Path, 'cwd', staticmethod(lambda: tmp_path / 'no'))
    msgs = [{'role': 'system', 'content': 'Working directory: /nonexistent/xyz'}]
    assert ri._detect_workspace(msgs) is None


def test_35_detect_cwd_git_fallback(tmp_path, monkeypatch):
    (tmp_path / '.git').mkdir()
    monkeypatch.setattr(Path, 'cwd', staticmethod(lambda: tmp_path))
    msgs = [{'role': 'system', 'content': 'no directory here'}]
    assert ri._detect_workspace(msgs) == tmp_path


def test_36_detect_cwd_no_git(tmp_path, monkeypatch):
    monkeypatch.setattr(Path, 'cwd', staticmethod(lambda: tmp_path))
    msgs = [{'role': 'system', 'content': 'no directory here'}]
    assert ri._detect_workspace(msgs) is None


def test_37_detect_empty_messages_cwd_fallback(tmp_path, monkeypatch):
    (tmp_path / '.git').mkdir()
    monkeypatch.setattr(Path, 'cwd', staticmethod(lambda: tmp_path))
    assert ri._detect_workspace([]) == tmp_path


def test_38_detect_case_variants(tmp_path, monkeypatch):
    (tmp_path / '.git').mkdir()
    monkeypatch.setattr(Path, 'cwd', staticmethod(lambda: tmp_path))
    # 'Working' matches pattern [Ww]orking; 'WORKING' does NOT
    msgs = [{'role': 'system', 'content': f'WORKING directory: {tmp_path}'}]
    # Regex won't match — falls through to cwd (which has .git)
    assert ri._detect_workspace(msgs) == tmp_path
    msgs2 = [{'role': 'system', 'content': f'Working directory: {tmp_path}'}]
    assert ri._detect_workspace(msgs2) == tmp_path


# ---------------------------------------------------------------------------
# GROUP F — _extract_query (39-43)
# ---------------------------------------------------------------------------

def test_39_extract_query_string_capped():
    assert ri._extract_query([{'role': 'user', 'content': 'hi'}]) == 'hi'


def test_40_extract_query_list_joined():
    msgs = [{'role': 'user', 'content': [
        {'type': 'text', 'text': 'a'},
        {'type': 'text', 'text': 'b'},
    ]}]
    assert ri._extract_query(msgs) == 'a\nb'


def test_41_extract_query_cap_500():
    long_text = 'x' * 1000
    result = ri._extract_query([{'role': 'user', 'content': long_text}])
    assert len(result) == 500


def test_42_extract_query_no_user_message():
    assert ri._extract_query([{'role': 'assistant', 'content': 'x'}]) == ''


def test_43_extract_query_last_user_wins():
    msgs = [
        {'role': 'user', 'content': 'first'},
        {'role': 'assistant', 'content': 'x'},
        {'role': 'user', 'content': 'second'},
    ]
    assert ri._extract_query(msgs) == 'second'


# ---------------------------------------------------------------------------
# GROUP G — _extract_keywords (44-50)
# ---------------------------------------------------------------------------

def test_44_keywords_stopwords_removed():
    kws = ri._extract_keywords('the file is that a thing')
    assert 'the' not in [k.lower() for k in kws]
    assert 'that' not in [k.lower() for k in kws]


def test_45_keywords_min_length_3():
    kws = ri._extract_keywords('ab cde fg hij')
    for k in kws:
        assert len(k) >= 3


def test_46_keywords_camelcase_preserved():
    kws = ri._extract_keywords('please call getUserById')
    assert 'getUserById' in kws


def test_47_keywords_snake_case_preserved():
    kws = ri._extract_keywords('please call get_user_by_id')
    assert 'get_user_by_id' in kws


def test_48_keywords_max_8():
    text = ' '.join(f'word{i}' for i in range(20))
    assert len(ri._extract_keywords(text)) <= 8


def test_49_keywords_empty():
    assert ri._extract_keywords('') == []


def test_50_keywords_only_stopwords():
    assert ri._extract_keywords('the a is that') == []


# ---------------------------------------------------------------------------
# GROUP H — _rg_available / _rg_search (51-58)
# ---------------------------------------------------------------------------

def test_51_rg_available_true(monkeypatch):
    monkeypatch.setattr(ri.subprocess, 'run', _fake_run(returncode=0))
    assert ri._rg_available() is True


def test_52_rg_available_missing(monkeypatch):
    monkeypatch.setattr(ri.subprocess, 'run',
                        _fake_run(raise_exc=FileNotFoundError()))
    assert ri._rg_available() is False


def test_53_rg_available_timeout(monkeypatch):
    monkeypatch.setattr(
        ri.subprocess, 'run',
        _fake_run(raise_exc=subprocess.TimeoutExpired('rg', 2)),
    )
    assert ri._rg_available() is False


def test_54_rg_search_no_keywords(tmp_path):
    assert ri._rg_search('the a is', tmp_path) == []


def test_55_rg_search_returns_snippets(tmp_path, monkeypatch):
    f = tmp_path / 'foo.py'
    f.write_text('line1\nline2 findMe here\nline3\n')
    ri._RG_OK = True
    monkeypatch.setattr(
        ri.subprocess, 'run',
        _fake_run(stdout=str(f) + '\n'),
    )
    hits = ri._rg_search('findMe query', tmp_path)
    assert len(hits) == 1
    assert 'findMe' in hits[0]['snippet']
    assert hits[0]['file'] == str(f)


def test_56_rg_search_dedup_by_path(tmp_path, monkeypatch):
    f = tmp_path / 'foo.py'
    f.write_text('alpha beta\n')
    ri._RG_OK = True
    # Every rg call returns the same path — dedup should keep it once.
    monkeypatch.setattr(
        ri.subprocess, 'run',
        _fake_run(stdout=str(f) + '\n'),
    )
    hits = ri._rg_search('alpha beta', tmp_path)
    assert len(hits) == 1


def test_57_rg_search_respects_max_results(tmp_path, monkeypatch):
    files = []
    for i, kw in enumerate(['alpha', 'beta', 'gamma', 'delta']):
        f = tmp_path / f'f{i}.py'
        f.write_text(f'{kw} content\n')
        files.append(str(f))
    ri._RG_OK = True

    call_iter = iter(files)

    def fake(cmd, **kw):
        try:
            path = next(call_iter)
        except StopIteration:
            path = ''
        return types.SimpleNamespace(stdout=path + '\n', stderr='', returncode=0)
    monkeypatch.setattr(ri.subprocess, 'run', fake)

    hits = ri._rg_search('alpha beta gamma delta', tmp_path, max_results=2)
    assert len(hits) == 2


def test_58_rg_search_py_grep_fallback(tmp_path, monkeypatch):
    f = tmp_path / 'foo.py'
    f.write_text('findMe here\n')
    ri._RG_OK = False
    # subprocess.run should NOT be called for rg — but _py_grep may be. Guard
    # by making run raise so any accidental use is caught.
    monkeypatch.setattr(
        ri.subprocess, 'run',
        _fake_run(raise_exc=AssertionError('should not call rg')),
    )
    hits = ri._rg_search('findMe query', tmp_path)
    assert len(hits) == 1
    assert hits[0]['file'].endswith('foo.py')


# ---------------------------------------------------------------------------
# GROUP I — _py_grep / _read_snippet (59-67)
# ---------------------------------------------------------------------------

def test_59_py_grep_finds_keyword(tmp_path):
    (tmp_path / 'a.py').write_text('foo bar findMe baz\n')
    hits = ri._py_grep('findMe', tmp_path)
    assert any('a.py' in h for h in hits)


def test_60_py_grep_case_insensitive(tmp_path):
    (tmp_path / 'a.py').write_text('FindMe here\n')
    hits = ri._py_grep('findme', tmp_path)
    assert any('a.py' in h for h in hits)


def test_61_py_grep_skips_git_dirs(tmp_path):
    (tmp_path / '.git').mkdir()
    (tmp_path / '.git' / 'x.py').write_text('findMe\n')
    (tmp_path / 'a.py').write_text('other\n')
    hits = ri._py_grep('findMe', tmp_path)
    assert not any('.git' in h for h in hits)


def test_62_py_grep_skips_node_modules(tmp_path):
    (tmp_path / 'node_modules').mkdir()
    (tmp_path / 'node_modules' / 'x.js').write_text('findMe\n')
    hits = ri._py_grep('findMe', tmp_path)
    assert not any('node_modules' in h for h in hits)


def test_63_py_grep_only_source_extensions(tmp_path):
    for ext in ('.py', '.js', '.mjs', '.ts', '.go', '.java', '.rs', '.c', '.cpp'):
        (tmp_path / f'src{ext}').write_text('findMe\n')
    (tmp_path / 'readme.md').write_text('findMe\n')
    (tmp_path / 'ignore.txt').write_text('findMe\n')
    hits = ri._py_grep('findMe', tmp_path, limit=99)
    exts = {os.path.splitext(h)[1] for h in hits}
    assert '.md' not in exts
    assert '.txt' not in exts
    assert '.py' in exts


def test_64_py_grep_limit(tmp_path):
    for i in range(5):
        (tmp_path / f'a{i}.py').write_text('findMe\n')
    hits = ri._py_grep('findMe', tmp_path, limit=2)
    assert len(hits) == 2


def test_65_read_snippet_first_n_lines(tmp_path):
    f = tmp_path / 'foo.txt'
    f.write_text('\n'.join(f'line{i}' for i in range(100)))
    snippet = ri._read_snippet(f, max_lines=5)
    assert snippet.count('\n') == 4  # 5 lines → 4 newlines
    assert 'line0' in snippet and 'line4' in snippet
    assert 'line5' not in snippet


def test_66_read_snippet_missing_file(tmp_path):
    assert ri._read_snippet(tmp_path / 'nope.txt') == ''


def test_67_read_snippet_binary_no_raise(tmp_path):
    f = tmp_path / 'bin.py'
    f.write_bytes(b'\xff\xfe\x00\x01text after\n')
    # Should not raise
    ri._read_snippet(f)


# ---------------------------------------------------------------------------
# GROUP J — _serena_search (68-76)
# ---------------------------------------------------------------------------

def test_68_serena_no_keywords(tmp_path):
    assert ri._serena_search('the a is', tmp_path) == []


def test_69_serena_success(tmp_path, monkeypatch):
    resp = json.dumps({
        'jsonrpc': '2.0', 'id': 1,
        'result': {'content': [{'type': 'text', 'text': 'match found'}]},
    })
    monkeypatch.setattr(
        ri.subprocess, 'run',
        _fake_run(stdout=(resp + '\n').encode()),
    )
    hits = ri._serena_search('findMe query please', tmp_path)
    assert len(hits) == 1
    assert 'match found' in hits[0]['snippet']


def test_70_serena_ignores_init_response(tmp_path, monkeypatch):
    init = json.dumps({'jsonrpc': '2.0', 'id': 0, 'result': {'x': 'ignored'}})
    real = json.dumps({
        'jsonrpc': '2.0', 'id': 1,
        'result': {'content': [{'type': 'text', 'text': 'kept'}]},
    })
    monkeypatch.setattr(
        ri.subprocess, 'run',
        _fake_run(stdout=(init + '\n' + real + '\n').encode()),
    )
    hits = ri._serena_search('findMe query', tmp_path)
    assert len(hits) == 1
    assert hits[0]['snippet'] == 'kept'


def test_71_serena_timeout(tmp_path, monkeypatch):
    monkeypatch.setattr(
        ri.subprocess, 'run',
        _fake_run(raise_exc=subprocess.TimeoutExpired('serena', 3)),
    )
    assert ri._serena_search('findMe query', tmp_path) == []


def test_72_serena_missing_binary(tmp_path, monkeypatch):
    monkeypatch.setattr(
        ri.subprocess, 'run',
        _fake_run(raise_exc=FileNotFoundError()),
    )
    assert ri._serena_search('findMe query', tmp_path) == []


def test_73_serena_malformed_json_lines(tmp_path, monkeypatch):
    payload = b'not-json\n{"broken":\nfoo bar\n'
    monkeypatch.setattr(ri.subprocess, 'run', _fake_run(stdout=payload))
    assert ri._serena_search('findMe query', tmp_path) == []


def test_74_serena_no_result_field(tmp_path, monkeypatch):
    resp = json.dumps({'jsonrpc': '2.0', 'id': 1, 'error': {'code': -1}})
    monkeypatch.setattr(
        ri.subprocess, 'run',
        _fake_run(stdout=(resp + '\n').encode()),
    )
    assert ri._serena_search('findMe query', tmp_path) == []


def test_75_serena_respects_max_snippets(tmp_path, monkeypatch):
    blocks = [{'type': 'text', 'text': f't{i}'} for i in range(10)]
    resp = json.dumps({
        'jsonrpc': '2.0', 'id': 1,
        'result': {'content': blocks},
    })
    monkeypatch.setattr(
        ri.subprocess, 'run',
        _fake_run(stdout=(resp + '\n').encode()),
    )
    monkeypatch.setattr(ri, 'MAX_SNIPPETS', 2)
    hits = ri._serena_search('findMe query', tmp_path)
    assert len(hits) == 2


def test_76_serena_content_truncated(tmp_path, monkeypatch):
    big = 'x' * 10000
    resp = json.dumps({
        'jsonrpc': '2.0', 'id': 1,
        'result': {'content': [{'type': 'text', 'text': big}]},
    })
    monkeypatch.setattr(
        ri.subprocess, 'run',
        _fake_run(stdout=(resp + '\n').encode()),
    )
    hits = ri._serena_search('findMe query', tmp_path)
    assert len(hits[0]['snippet']) == ri.SNIPPET_LINES * 80


# ---------------------------------------------------------------------------
# GROUP K — Public API (77-91)
# ---------------------------------------------------------------------------

def test_77_should_inject_disabled_by_default(monkeypatch):
    monkeypatch.setattr(ri, 'RAG_ENABLED', False)
    assert ri.should_inject([]) is False


def test_78_should_inject_enabled_no_serena(monkeypatch):
    monkeypatch.setattr(ri, 'RAG_ENABLED', True)
    assert ri.should_inject([{'name': 'Read'}]) is True


def test_79_should_inject_enabled_with_serena(monkeypatch):
    monkeypatch.setattr(ri, 'RAG_ENABLED', True)
    assert ri.should_inject([{'name': 'serena_find_symbol'}]) is False


def test_80_build_context_block_empty():
    assert ri.build_context_block([]) is None


def test_81_build_context_block_single():
    out = ri.build_context_block([{'file': '/a.py', 'snippet': 'body'}])
    assert '/a.py' in out
    assert 'body' in out


def test_82_build_context_block_multiple():
    out = ri.build_context_block([
        {'file': '/a.py', 'snippet': 'aa'},
        {'file': '/b.py', 'snippet': 'bb'},
    ])
    assert '/a.py' in out and '/b.py' in out


def test_83_inject_short_circuits_no_messages():
    data = {'messages': [], 'tools': []}
    assert ri.inject_rag_context(data) is data


def test_84_inject_short_circuits_should_inject_false(monkeypatch):
    monkeypatch.setattr(ri, 'RAG_ENABLED', False)
    data = {'messages': [{'role': 'user', 'content': 'hi'}], 'tools': []}
    assert ri.inject_rag_context(data) is data


def test_85_inject_short_circuits_no_query(monkeypatch):
    monkeypatch.setattr(ri, 'RAG_ENABLED', True)
    data = {'messages': [{'role': 'assistant', 'content': 'hi'}], 'tools': []}
    assert ri.inject_rag_context(data) is data


def test_86_inject_short_circuits_no_workspace(monkeypatch):
    monkeypatch.setattr(ri, 'RAG_ENABLED', True)
    monkeypatch.setattr(ri, '_detect_workspace', lambda m: None)
    data = {'messages': [{'role': 'user', 'content': 'find something'}], 'tools': []}
    assert ri.inject_rag_context(data) is data


def test_87_inject_short_circuits_no_snippets(monkeypatch, tmp_path):
    monkeypatch.setattr(ri, 'RAG_ENABLED', True)
    monkeypatch.setattr(ri, '_detect_workspace', lambda m: tmp_path)
    monkeypatch.setattr(ri, '_is_serena_running', lambda: False)
    monkeypatch.setattr(ri, '_rg_search', lambda q, w, max_results=3: [])
    data = {
        'messages': [
            {'role': 'user', 'content': 'first'},
            {'role': 'assistant', 'content': 'reply'},
            {'role': 'user', 'content': 'find something'},
        ],
        'tools': [],
    }
    assert ri.inject_rag_context(data) is data


def test_88_inject_short_circuits_first_user_is_idx0(monkeypatch, tmp_path):
    monkeypatch.setattr(ri, 'RAG_ENABLED', True)
    monkeypatch.setattr(ri, '_detect_workspace', lambda m: tmp_path)
    monkeypatch.setattr(ri, '_is_serena_running', lambda: False)
    monkeypatch.setattr(
        ri, '_rg_search',
        lambda q, w, max_results=3: [{'file': '/a', 'snippet': 'body'}],
    )
    data = {
        'messages': [{'role': 'user', 'content': 'find something'}],
        'tools': [],
    }
    assert ri.inject_rag_context(data) is data


def test_89_inject_success_prepends_at_correct_position(monkeypatch, tmp_path):
    monkeypatch.setattr(ri, 'RAG_ENABLED', True)
    monkeypatch.setattr(ri, '_detect_workspace', lambda m: tmp_path)
    monkeypatch.setattr(ri, '_is_serena_running', lambda: False)
    monkeypatch.setattr(
        ri, '_rg_search',
        lambda q, w, max_results=3: [{'file': '/a.py', 'snippet': 'code'}],
    )
    data = {
        'messages': [
            {'role': 'user', 'content': 'first'},
            {'role': 'assistant', 'content': 'reply'},
            {'role': 'user', 'content': 'find something'},
        ],
        'tools': [],
    }
    out = ri.inject_rag_context(data)
    msgs = out['messages']
    # Injection goes immediately before the LAST user message (idx 2)
    assert len(msgs) == 4
    assert msgs[2]['role'] == 'assistant'
    assert 'Myelin context' in msgs[2]['content']
    assert msgs[3]['content'] == 'find something'


def test_90_inject_uses_serena_when_running(monkeypatch, tmp_path):
    monkeypatch.setattr(ri, 'RAG_ENABLED', True)
    monkeypatch.setattr(ri, '_detect_workspace', lambda m: tmp_path)
    monkeypatch.setattr(ri, '_is_serena_running', lambda: True)
    calls = {'serena': 0, 'rg': 0}

    def fake_serena(q, w):
        calls['serena'] += 1
        return [{'file': '(serena)', 'snippet': 'from-serena'}]

    def fake_rg(q, w, max_results=3):
        calls['rg'] += 1
        return [{'file': '(rg)', 'snippet': 'from-rg'}]

    monkeypatch.setattr(ri, '_serena_search', fake_serena)
    monkeypatch.setattr(ri, '_rg_search', fake_rg)

    data = {
        'messages': [
            {'role': 'user', 'content': 'first'},
            {'role': 'assistant', 'content': 'reply'},
            {'role': 'user', 'content': 'find something'},
        ],
        'tools': [],
    }
    out = ri.inject_rag_context(data)
    assert calls['serena'] == 1
    assert calls['rg'] == 0
    assert 'from-serena' in out['messages'][2]['content']


def test_91_inject_does_not_mutate_original(monkeypatch, tmp_path):
    monkeypatch.setattr(ri, 'RAG_ENABLED', True)
    monkeypatch.setattr(ri, '_detect_workspace', lambda m: tmp_path)
    monkeypatch.setattr(ri, '_is_serena_running', lambda: False)
    monkeypatch.setattr(
        ri, '_rg_search',
        lambda q, w, max_results=3: [{'file': '/a', 'snippet': 'body'}],
    )
    original_messages = [
        {'role': 'user', 'content': 'first'},
        {'role': 'assistant', 'content': 'reply'},
        {'role': 'user', 'content': 'find something'},
    ]
    data = {'messages': original_messages, 'tools': []}
    out = ri.inject_rag_context(data)
    # Original list untouched
    assert len(data['messages']) == 3
    assert data['messages'] is original_messages
    # Modified dict is a new object with a new messages list
    assert out is not data
    assert out['messages'] is not original_messages
