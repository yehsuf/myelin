"""Unit tests for src/mitm/tool_filter.py — 92 test cases.

Covers:
  A. last_user_text                       1-10
  B. _conversation_key                    11-15
  C. _tokenise                            16-21
  D. _humanise_name                       22-30
  E. _tool_text                           31-36
  F. _BM25.rank                           37-45
  G. _rrf                                 46-51
  H. filter_tools                         52-68
  I. _referenced_tool_names               69-76
  J. _LRUDict                             77-90
  K. Integration                          91-92
"""
import importlib
import os
import re
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'src', 'mitm'))
import tool_filter as tf  # noqa: E402


# ---------------------------------------------------------------------------
# Fixtures / helpers
# ---------------------------------------------------------------------------

def setup_function(function):
    """Reset the per-conversation cache and neutralise model2vec before each
    test so nothing leaks between tests."""
    tf._last_tool_sets = tf._LRUDict(tf._CACHE_SIZE)
    tf._HAS_M2V = False
    tf._MODEL = None


def _mk_user(text):
    return {'role': 'user', 'content': text}


def _mk_assistant(text):
    return {'role': 'assistant', 'content': text}


def _mk_tool(name, desc=''):
    return {'name': name, 'description': desc}


# ---------------------------------------------------------------------------
# GROUP A — last_user_text (1-10)
# ---------------------------------------------------------------------------

def test_01_last_user_text_string_content():
    assert tf.last_user_text([_mk_user('hello world')]) == 'hello world'


def test_02_last_user_text_list_single_text_block():
    msgs = [{'role': 'user', 'content': [{'type': 'text', 'text': 'hello'}]}]
    assert tf.last_user_text(msgs) == 'hello'


def test_03_last_user_text_list_multiple_text_blocks_joined_newline():
    msgs = [{'role': 'user', 'content': [
        {'type': 'text', 'text': 'a'},
        {'type': 'text', 'text': 'b'},
    ]}]
    assert tf.last_user_text(msgs) == 'a\nb'


def test_04_last_user_text_list_ignores_non_text_blocks():
    msgs = [{'role': 'user', 'content': [
        {'type': 'image', 'text': 'ignored'},
        {'type': 'text', 'text': 'kept'},
        {'type': 'tool_use', 'name': 'x'},
    ]}]
    assert tf.last_user_text(msgs) == 'kept'


def test_05_last_user_text_returns_last_user_when_multiple():
    msgs = [_mk_user('first'), _mk_assistant('mid'), _mk_user('second')]
    assert tf.last_user_text(msgs) == 'second'


def test_06_last_user_text_skips_assistant():
    msgs = [_mk_user('u'), _mk_assistant('a')]
    assert tf.last_user_text(msgs) == 'u'


def test_07_last_user_text_no_user_message():
    assert tf.last_user_text([_mk_assistant('a')]) == ''


def test_08_last_user_text_empty_messages():
    assert tf.last_user_text([]) == ''


def test_09_last_user_text_list_no_text_blocks():
    msgs = [{'role': 'user', 'content': [{'type': 'image'}]}]
    assert tf.last_user_text(msgs) == ''


def test_10_last_user_text_unknown_content_type_int():
    msgs = [{'role': 'user', 'content': 42}]
    assert tf.last_user_text(msgs) == ''


# ---------------------------------------------------------------------------
# GROUP B — _conversation_key (11-15)
# ---------------------------------------------------------------------------

def test_11_conv_key_same_first_message_same_key():
    m1 = [_mk_user('same')]
    m2 = [_mk_user('same')]
    assert tf._conversation_key(m1) == tf._conversation_key(m2)


def test_12_conv_key_different_first_message_different_key():
    m1 = [_mk_user('a')]
    m2 = [_mk_user('b')]
    assert tf._conversation_key(m1) != tf._conversation_key(m2)


def test_13_conv_key_only_first_message_matters():
    m1 = [_mk_user('root'), _mk_assistant('x'), _mk_user('follow-a')]
    m2 = [_mk_user('root'), _mk_assistant('y'), _mk_user('follow-b')]
    assert tf._conversation_key(m1) == tf._conversation_key(m2)


def test_14_conv_key_empty_messages_deterministic():
    k1 = tf._conversation_key([])
    k2 = tf._conversation_key([])
    assert k1 == k2
    assert len(k1) == 12


def test_15_conv_key_is_12_hex_chars():
    k = tf._conversation_key([_mk_user('anything')])
    assert re.match(r'^[0-9a-f]{12}$', k)


# ---------------------------------------------------------------------------
# GROUP C — _tokenise (16-21)
# ---------------------------------------------------------------------------

def test_16_tokenise_lowercases():
    assert tf._tokenise('Hello WORLD') == ['hello', 'world']


def test_17_tokenise_strips_punctuation():
    assert tf._tokenise('hello, world!') == ['hello', 'world']


def test_18_tokenise_keeps_digits():
    assert tf._tokenise('v2 api3') == ['v2', 'api3']


def test_19_tokenise_empty():
    assert tf._tokenise('') == []


def test_20_tokenise_only_punctuation():
    assert tf._tokenise('.,!?;') == []


def test_21_tokenise_camelcase_not_split():
    # _tokenise alone doesn't split camelCase — that's _humanise_name's job.
    assert tf._tokenise('getUserById') == ['getuserbyid']


# ---------------------------------------------------------------------------
# GROUP D — _humanise_name (22-30)
# ---------------------------------------------------------------------------

def test_22_humanise_camel_case():
    assert tf._humanise_name('getUserById') == 'get User By Id'


def test_23_humanise_snake_case():
    assert tf._humanise_name('get_user_by_id') == 'get user by id'


def test_24_humanise_dotted():
    assert tf._humanise_name('serena.find_symbol') == 'serena find symbol'


def test_25_humanise_hyphenated():
    assert tf._humanise_name('get-user-by-id') == 'get user by id'


def test_26_humanise_slash():
    assert tf._humanise_name('a/b/c') == 'a b c'


def test_27_humanise_mixed():
    out = tf._humanise_name('getUser_byId.find')
    assert ' ' in out
    # camelCase boundary + underscore + dot all become spaces
    assert out == 'get User by Id find'


def test_28_humanise_all_lower_unchanged():
    assert tf._humanise_name('simple') == 'simple'


def test_29_humanise_empty():
    assert tf._humanise_name('') == ''


def test_30_humanise_digits_boundary():
    assert tf._humanise_name('v2Api') == 'v2 Api'


# ---------------------------------------------------------------------------
# GROUP E — _tool_text (31-36)
# ---------------------------------------------------------------------------

def test_31_tool_text_name_only():
    assert tf._tool_text({'name': 'getUser'}) == 'get User'


def test_32_tool_text_name_plus_description():
    out = tf._tool_text({'name': 'getUser', 'description': 'fetch a user'})
    assert out == 'get User fetch a user'


def test_33_tool_text_oai_function_description():
    out = tf._tool_text({'name': 'x', 'function': {'description': 'fx'}})
    assert 'fx' in out


def test_34_tool_text_top_level_description_wins():
    out = tf._tool_text({'name': 'x',
                         'description': 'top',
                         'function': {'description': 'inner'}})
    assert 'top' in out
    assert 'inner' not in out


def test_35_tool_text_missing_name():
    # name key absent → _humanise_name('') == '' → parts = [''] → joined ' d'
    out = tf._tool_text({'description': 'd'})
    assert out == ' d'


def test_36_tool_text_missing_everything():
    assert tf._tool_text({}) == ''


# ---------------------------------------------------------------------------
# GROUP F — _BM25.rank (37-45)
# ---------------------------------------------------------------------------

def test_37_bm25_basic_ranking():
    docs = [['python', 'file'], ['read', 'a', 'file'], ['unrelated']]
    bm = tf._BM25(docs)
    ranks = bm.rank('read file', 3)
    assert ranks[0] == 1


def test_38_bm25_empty_query_returns_first_k():
    docs = [['a'], ['b'], ['c']]
    bm = tf._BM25(docs)
    assert bm.rank('', 2) == [0, 1]


def test_39_bm25_query_no_matches_all_zero():
    docs = [['a'], ['b'], ['c']]
    bm = tf._BM25(docs)
    ranks = bm.rank('zzz', 3)
    assert sorted(ranks) == [0, 1, 2]
    for i in range(3):
        assert bm.score(['zzz'], i) == 0.0


def test_40_bm25_single_doc():
    bm = tf._BM25([['x']])
    assert bm.rank('x', 5) == [0]


def test_41_bm25_zero_docs():
    bm = tf._BM25([])
    assert bm.rank('anything', 5) == []


def test_42_bm25_k_greater_than_n():
    docs = [['a'], ['b']]
    bm = tf._BM25(docs)
    assert len(bm.rank('a', 99)) == 2


def test_43_bm25_k_zero():
    docs = [['a'], ['b']]
    bm = tf._BM25(docs)
    assert bm.rank('a', 0) == []


def test_44_bm25_multi_term_query_prefers_more_matches():
    docs = [
        ['read', 'file'],   # matches both terms
        ['read', 'nothing'],  # matches one term
    ]
    bm = tf._BM25(docs)
    ranks = bm.rank('read file', 2)
    assert ranks[0] == 0


def test_45_bm25_rare_term_higher_idf():
    docs = [
        ['common', 'common', 'rare'],
        ['common'],
        ['common'],
    ]
    bm = tf._BM25(docs)
    common_score = bm.score(['common'], 0)
    rare_score = bm.score(['rare'], 0)
    assert rare_score > common_score


# ---------------------------------------------------------------------------
# GROUP G — _rrf (46-51)
# ---------------------------------------------------------------------------

def test_46_rrf_single_list_preserves_order():
    assert tf._rrf([[2, 0, 1]]) == [2, 0, 1]


def test_47_rrf_two_lists_agreeing():
    assert tf._rrf([[0, 1, 2], [0, 1, 2]]) == [0, 1, 2]


def test_48_rrf_disagreeing_pos0_beats_mid():
    # Item 5 appears at position 0 in list-B — beats mid-ranked items
    result = tf._rrf([[0, 1, 2, 3, 4], [5, 6, 7, 8, 9]])
    assert result[0] in (0, 5)
    # Both should come well before position-mid items
    assert result.index(2) > result.index(0)
    assert result.index(7) > result.index(5)


def test_49_rrf_missing_from_one_list():
    # item 0 appears in both, item 99 appears in only one
    result = tf._rrf([[0, 1, 2], [0, 99]])
    assert result.index(0) < result.index(99)


def test_50_rrf_empty_lists():
    assert tf._rrf([]) == []
    assert tf._rrf([[], []]) == []


def test_51_rrf_k_param_affects_ordering():
    # Different k values produce numerically different scores but the
    # relative ordering of a mostly-agreeing pair is stable. Show at least
    # that k=1 vs k=1000 both terminate and return the same set.
    a = tf._rrf([[0, 1, 2, 3], [3, 2, 1, 0]], k=1)
    b = tf._rrf([[0, 1, 2, 3], [3, 2, 1, 0]], k=1000)
    assert sorted(a) == sorted(b) == [0, 1, 2, 3]
    # k=1 with strong rank-0 hit distinguishes items far more than k=1000
    # A very small k makes 1/(k+1) dominate, so 0 and 3 should be at ends
    assert set(a[:2]) == {0, 3}


# ---------------------------------------------------------------------------
# GROUP H — filter_tools (52-68)
# ---------------------------------------------------------------------------

def _big_tool_list(n, prefix='tool_'):
    return [_mk_tool(f'{prefix}{i}', f'desc {i}') for i in range(n)]


def test_52_below_min_tools_returns_unchanged():
    tools = _big_tool_list(3)  # default MIN_TOOLS=15
    msgs = [_mk_user('hello')]
    result, changed = tf.filter_tools(tools, msgs)
    assert result is tools
    assert changed is False


def test_53_exactly_min_tools_triggers_filtering(monkeypatch):
    monkeypatch.setattr(tf, 'MIN_TOOLS', 3)
    monkeypatch.setattr(tf, 'TOP_K', 1)
    tools = [
        _mk_tool('search_flights', 'search for flights in a city'),
        _mk_tool('drop_table', 'drop a database table'),
        _mk_tool('bake_cake', 'bake a chocolate cake'),
    ]
    msgs = [_mk_user('find flights in Paris city')]
    result, _ = tf.filter_tools(tools, msgs)
    # Filtered — fewer than 3 tools returned (TOP_K=1, none are always-on)
    assert len(result) < len(tools)
    assert any(t['name'] == 'search_flights' for t in result)


def test_54_filter_disabled(monkeypatch):
    monkeypatch.setattr(tf, 'FILTER_ENABLED', False)
    tools = _big_tool_list(50)
    msgs = [_mk_user('foo bar')]
    result, changed = tf.filter_tools(tools, msgs)
    assert result is tools
    assert changed is False


def test_55_always_on_preserved(monkeypatch):
    monkeypatch.setattr(tf, 'MIN_TOOLS', 2)
    monkeypatch.setattr(tf, 'TOP_K', 1)
    tools = [
        _mk_tool('Read', 'read a file'),        # always on
        _mk_tool('Bash', 'run a command'),      # always on
        _mk_tool('search_flights', 'search flights'),
        _mk_tool('drop_table', 'drop database'),
    ]
    msgs = [_mk_user('completely unrelated query')]
    result, _ = tf.filter_tools(tools, msgs)
    names = {t['name'] for t in result}
    assert 'Read' in names and 'Bash' in names


def test_56_relevant_tool_kept(monkeypatch):
    monkeypatch.setattr(tf, 'MIN_TOOLS', 2)
    monkeypatch.setattr(tf, 'TOP_K', 1)
    tools = [
        _mk_tool('search_flights', 'search for flights in a city'),
        _mk_tool('drop_table', 'drop a database table'),
    ]
    msgs = [_mk_user('flights city')]
    result, _ = tf.filter_tools(tools, msgs)
    assert any(t['name'] == 'search_flights' for t in result)


def test_57_top_k_limit_enforced(monkeypatch):
    monkeypatch.setattr(tf, 'MIN_TOOLS', 2)
    monkeypatch.setattr(tf, 'TOP_K', 2)
    tools = [_mk_tool(f'tool_{i}', f'query match {i}') for i in range(10)]
    msgs = [_mk_user('query match')]
    result, _ = tf.filter_tools(tools, msgs)
    assert len(result) <= 2


def test_58_original_declaration_order_preserved(monkeypatch):
    monkeypatch.setattr(tf, 'MIN_TOOLS', 3)
    monkeypatch.setattr(tf, 'TOP_K', 3)
    tools = [
        _mk_tool('zzz_last', 'query match match'),
        _mk_tool('mmm_mid',  'query match match match'),
        _mk_tool('aaa_first', 'query match'),
        _mk_tool('unrelated', 'nothing here'),
    ]
    msgs = [_mk_user('query match')]
    result, _ = tf.filter_tools(tools, msgs)
    kept_set = {t['name'] for t in result}
    expected_order = [t['name'] for t in tools if t['name'] in kept_set]
    assert [t['name'] for t in result] == expected_order


def test_59_referenced_tool_preserved(monkeypatch):
    monkeypatch.setattr(tf, 'MIN_TOOLS', 2)
    monkeypatch.setattr(tf, 'TOP_K', 1)
    tools = [
        _mk_tool('match_a', 'query match'),
        _mk_tool('other_b', 'orphan'),
        _mk_tool('other_c', 'orphan'),
    ]
    msgs = [
        _mk_user('start'),
        {'role': 'assistant', 'content': [
            {'type': 'tool_use', 'name': 'other_b', 'id': 'x', 'input': {}}]},
        _mk_user('query match'),
    ]
    result, _ = tf.filter_tools(tools, msgs)
    names = {t['name'] for t in result}
    assert 'other_b' in names


def test_60_multi_turn_referenced_all_preserved(monkeypatch):
    monkeypatch.setattr(tf, 'MIN_TOOLS', 2)
    monkeypatch.setattr(tf, 'TOP_K', 1)
    tools = [_mk_tool(f'tool_{i}') for i in range(6)]
    msgs = [
        _mk_user('start'),
        {'role': 'assistant', 'content': [
            {'type': 'tool_use', 'name': 'tool_1', 'id': 'a', 'input': {}}]},
        _mk_user('more'),
        {'role': 'assistant', 'content': [
            {'type': 'tool_use', 'name': 'tool_4', 'id': 'b', 'input': {}}]},
        _mk_user('final'),
    ]
    result, _ = tf.filter_tools(tools, msgs)
    names = {t['name'] for t in result}
    assert 'tool_1' in names and 'tool_4' in names


def test_61_no_tool_use_no_extra_tools(monkeypatch):
    monkeypatch.setattr(tf, 'MIN_TOOLS', 2)
    monkeypatch.setattr(tf, 'TOP_K', 2)
    tools = [_mk_tool(f'tool_{i}', f'nomatch {i}') for i in range(6)]
    msgs = [_mk_user('completely irrelevant query zzz')]
    result, _ = tf.filter_tools(tools, msgs)
    # No always-on, no referenced, top_K=2 → result size == 2
    assert len(result) == 2


def test_62_changed_true_on_first_call(monkeypatch):
    monkeypatch.setattr(tf, 'MIN_TOOLS', 2)
    monkeypatch.setattr(tf, 'TOP_K', 1)
    tools = [_mk_tool('a', 'query match'), _mk_tool('b', 'irrelevant')]
    msgs = [_mk_user('query match')]
    _, changed = tf.filter_tools(tools, msgs)
    assert changed is True


def test_63_changed_false_on_same_second_call(monkeypatch):
    monkeypatch.setattr(tf, 'MIN_TOOLS', 2)
    monkeypatch.setattr(tf, 'TOP_K', 1)
    tools = [_mk_tool('a', 'query match'), _mk_tool('b', 'irrelevant')]
    msgs = [_mk_user('query match')]
    tf.filter_tools(tools, msgs)
    _, changed = tf.filter_tools(tools, msgs)
    assert changed is False


def test_64_changed_true_on_different_topk_set(monkeypatch):
    monkeypatch.setattr(tf, 'MIN_TOOLS', 2)
    monkeypatch.setattr(tf, 'TOP_K', 1)
    tools = [
        _mk_tool('flight_search', 'find flights in city'),
        _mk_tool('cake_recipe',   'bake a chocolate cake'),
    ]
    root = _mk_user('conversation start')
    msgs1 = [root, _mk_user('find flights city')]
    msgs2 = [root, _mk_user('bake chocolate cake')]
    _, c1 = tf.filter_tools(tools, msgs1)
    _, c2 = tf.filter_tools(tools, msgs2)
    assert c1 is True
    assert c2 is True


def test_65_empty_query(monkeypatch):
    monkeypatch.setattr(tf, 'MIN_TOOLS', 2)
    tools = [_mk_tool('a'), _mk_tool('b')]
    msgs = [_mk_user('   ')]
    result, changed = tf.filter_tools(tools, msgs)
    assert result is tools
    assert changed is False


def test_66_all_always_on(monkeypatch):
    monkeypatch.setattr(tf, 'MIN_TOOLS', 2)
    tools = [_mk_tool('Read'), _mk_tool('Bash')]
    msgs = [_mk_user('hello')]
    result, changed = tf.filter_tools(tools, msgs)
    assert result is tools
    assert changed is False


def test_67_oai_format_name_not_always_on(monkeypatch):
    monkeypatch.setattr(tf, 'MIN_TOOLS', 2)
    monkeypatch.setattr(tf, 'TOP_K', 1)
    # Known limitation: filter_tools inspects tool['name'] at the top level
    # only; OAI-nested {'function': {'name': 'Read'}} is not recognised as
    # always-on. Documented so a future OAI-aware refactor can update this
    # expectation deliberately.
    tools = [
        {'function': {'name': 'Read', 'description': 'reader'}},
        _mk_tool('match', 'query match'),
    ]
    msgs = [_mk_user('query match')]
    result, _ = tf.filter_tools(tools, msgs)
    names = [t.get('name') or t.get('function', {}).get('name') for t in result]
    assert 'match' in names
    assert 'Read' not in names  # OAI-nested name is NOT treated as always-on


def test_68_result_is_subset_by_identity(monkeypatch):
    monkeypatch.setattr(tf, 'MIN_TOOLS', 3)
    monkeypatch.setattr(tf, 'TOP_K', 2)
    tools = [_mk_tool(f'tool_{i}', f'query match {i}') for i in range(5)]
    msgs = [_mk_user('query match')]
    result, _ = tf.filter_tools(tools, msgs)
    for r in result:
        assert any(r is t for t in tools)


def _mk_tool_defer(name, defer, desc=''):
    return {'name': name, 'description': desc, 'defer_loading': defer}


def test_68a_deferred_tools_present_skips_filtering(monkeypatch):
    # When the client uses deferred tool loading, filtering must be a no-op so
    # it can never drop every defer_loading=false tool (provider 400) or hide a
    # deferred tool from tool-search.
    monkeypatch.setattr(tf, 'MIN_TOOLS', 2)
    monkeypatch.setattr(tf, 'TOP_K', 1)
    tools = [
        _mk_tool_defer('anchor', False, 'the one eager tool'),
        _mk_tool_defer('search_flights', True, 'search flights'),
        _mk_tool_defer('drop_table', True, 'drop database'),
    ]
    msgs = [_mk_user('completely unrelated query')]
    result, changed = tf.filter_tools(tools, msgs)
    assert result is tools, 'must pass tools through untouched when deferral is active'
    assert changed is False


def test_68b_at_least_one_non_deferred_survives(monkeypatch):
    # The invariant the provider enforces: at least one defer_loading=false tool
    # must remain in the forwarded array.
    monkeypatch.setattr(tf, 'MIN_TOOLS', 2)
    monkeypatch.setattr(tf, 'TOP_K', 1)
    tools = [_mk_tool_defer('anchor', False, 'eager anchor')] + [
        _mk_tool_defer(f'deferred_{i}', True, f'irrelevant {i}') for i in range(20)
    ]
    msgs = [_mk_user('nothing matches these tools at all zzz')]
    result, _ = tf.filter_tools(tools, msgs)
    assert any(t.get('defer_loading') is False for t in result), \
        'at least one defer_loading=false tool must survive'


def test_68c_no_defer_field_filters_normally(monkeypatch):
    # Requests without any deferred tools filter as before (no regression).
    monkeypatch.setattr(tf, 'MIN_TOOLS', 2)
    monkeypatch.setattr(tf, 'TOP_K', 1)
    tools = [
        _mk_tool('search_flights', 'search for flights in a city'),
        _mk_tool('drop_table', 'drop a database table'),
        _mk_tool('bake_cake', 'bake a chocolate cake'),
    ]
    msgs = [_mk_user('find flights in Paris city')]
    result, _ = tf.filter_tools(tools, msgs)
    assert len(result) < len(tools)


def test_68d_defer_loading_false_only_filters_normally(monkeypatch):
    # All tools explicitly non-deferred (defer_loading=false) → filter normally.
    monkeypatch.setattr(tf, 'MIN_TOOLS', 2)
    monkeypatch.setattr(tf, 'TOP_K', 1)
    tools = [
        _mk_tool_defer('search_flights', False, 'search for flights in a city'),
        _mk_tool_defer('drop_table', False, 'drop a database table'),
        _mk_tool_defer('bake_cake', False, 'bake a chocolate cake'),
    ]
    msgs = [_mk_user('find flights in Paris city')]
    result, _ = tf.filter_tools(tools, msgs)
    assert len(result) < len(tools)


def test_68e_truthy_defer_value_still_skips(monkeypatch):
    # Non-standard truthy defer_loading (e.g. a string) errs toward NOT
    # filtering, so it can never trip the provider 400.
    monkeypatch.setattr(tf, 'MIN_TOOLS', 2)
    monkeypatch.setattr(tf, 'TOP_K', 1)
    tools = [
        _mk_tool_defer('anchor', False, 'eager'),
        {'name': 'weird', 'description': 'x', 'defer_loading': 'true'},
        _mk_tool('other', 'y'),
    ]
    msgs = [_mk_user('unrelated')]
    result, changed = tf.filter_tools(tools, msgs)
    assert result is tools
    assert changed is False


# ---------------------------------------------------------------------------
# GROUP I — _referenced_tool_names (69-76)
# ---------------------------------------------------------------------------

def test_69_ref_no_tool_use():
    assert tf._referenced_tool_names([_mk_user('x')]) == set()


def test_70_ref_single_tool_use():
    msgs = [{'role': 'assistant', 'content': [
        {'type': 'tool_use', 'name': 'X', 'id': 'a', 'input': {}}]}]
    assert tf._referenced_tool_names(msgs) == {'X'}


def test_71_ref_multiple_tool_use_same_msg():
    msgs = [{'role': 'assistant', 'content': [
        {'type': 'tool_use', 'name': 'A', 'id': 'a', 'input': {}},
        {'type': 'tool_use', 'name': 'B', 'id': 'b', 'input': {}},
    ]}]
    assert tf._referenced_tool_names(msgs) == {'A', 'B'}


def test_72_ref_multiple_tool_use_multi_turn():
    msgs = [
        {'role': 'assistant', 'content': [
            {'type': 'tool_use', 'name': 'A', 'id': 'a', 'input': {}}]},
        _mk_user('x'),
        {'role': 'assistant', 'content': [
            {'type': 'tool_use', 'name': 'B', 'id': 'b', 'input': {}}]},
    ]
    assert tf._referenced_tool_names(msgs) == {'A', 'B'}


def test_73_ref_tool_use_without_name():
    msgs = [{'role': 'assistant', 'content': [
        {'type': 'tool_use', 'id': 'a', 'input': {}}]}]
    assert tf._referenced_tool_names(msgs) == set()


def test_74_ref_non_list_content_skipped():
    msgs = [_mk_user('some string content')]
    assert tf._referenced_tool_names(msgs) == set()


def test_75_ref_non_dict_blocks_skipped():
    msgs = [{'role': 'assistant', 'content': ['a string block', 42, None]}]
    assert tf._referenced_tool_names(msgs) == set()


def test_76_ref_non_tool_use_block_types():
    msgs = [{'role': 'assistant', 'content': [
        {'type': 'text', 'text': 'hi'},
        {'type': 'tool_result', 'tool_use_id': 'x'},
    ]}]
    assert tf._referenced_tool_names(msgs) == set()


# ---------------------------------------------------------------------------
# GROUP J — _LRUDict (77-90)
# ---------------------------------------------------------------------------

def test_77_lru_get_missing_returns_default():
    lru = tf._LRUDict(5)
    assert lru.get('missing') is None
    assert lru.get('missing', 'd') == 'd'


def test_78_lru_setitem_get_roundtrip():
    lru = tf._LRUDict(5)
    lru['k'] = frozenset({'a'})
    assert lru.get('k') == frozenset({'a'})


def test_79_lru_contains():
    lru = tf._LRUDict(5)
    assert 'x' not in lru
    lru['x'] = frozenset()
    assert 'x' in lru


def test_80_lru_len_grows():
    lru = tf._LRUDict(5)
    assert len(lru) == 0
    lru['a'] = frozenset()
    lru['b'] = frozenset()
    assert len(lru) == 2


def test_81_lru_evicts_when_over_maxsize():
    lru = tf._LRUDict(3)
    for k in ('a', 'b', 'c', 'd'):
        lru[k] = frozenset({k})
    assert 'a' not in lru
    assert {'b', 'c', 'd'} == set(lru._data.keys())


def test_82_lru_size_never_exceeds():
    lru = tf._LRUDict(10)
    for i in range(100):
        lru[str(i)] = frozenset({str(i)})
    assert len(lru) == 10


def test_83_lru_get_moves_to_end():
    lru = tf._LRUDict(3)
    lru['k0'] = frozenset()
    lru['k1'] = frozenset()
    lru['k2'] = frozenset()
    lru.get('k0')  # refresh
    lru['k3'] = frozenset()
    assert 'k0' in lru
    assert 'k1' not in lru


def test_84_lru_setitem_update_moves_to_end():
    lru = tf._LRUDict(3)
    lru['k0'] = frozenset({'a'})
    lru['k1'] = frozenset()
    lru['k2'] = frozenset()
    lru['k0'] = frozenset({'b'})  # update refreshes recency
    lru['k3'] = frozenset()
    assert 'k0' in lru
    assert 'k1' not in lru
    assert lru.get('k0') == frozenset({'b'})


def test_85_lru_getitem_missing_raises():
    lru = tf._LRUDict(3)
    with pytest.raises(KeyError):
        _ = lru['nope']


def test_86_lru_getitem_moves_to_end():
    lru = tf._LRUDict(3)
    lru['k0'] = frozenset()
    lru['k1'] = frozenset()
    lru['k2'] = frozenset()
    _ = lru['k0']  # refresh
    lru['k3'] = frozenset()
    assert 'k0' in lru
    assert 'k1' not in lru


def test_87_lru_maxsize_1():
    lru = tf._LRUDict(1)
    lru['a'] = frozenset()
    lru['b'] = frozenset()
    assert 'a' not in lru
    assert 'b' in lru


def test_88_lru_maxsize_0_coerced_to_1():
    lru = tf._LRUDict(0)
    assert lru._maxsize == 1


def test_89_env_override_cache_size(monkeypatch):
    monkeypatch.setenv('MYELIN_TOOL_FILTER_CACHE_SIZE', '7')
    importlib.reload(tf)
    try:
        assert tf._CACHE_SIZE == 7
        assert tf._last_tool_sets._maxsize == 7
    finally:
        # restore default state for later tests
        monkeypatch.delenv('MYELIN_TOOL_FILTER_CACHE_SIZE', raising=False)
        importlib.reload(tf)


def test_90_default_cache_size():
    # reload without the env var to observe the default
    os.environ.pop('MYELIN_TOOL_FILTER_CACHE_SIZE', None)
    importlib.reload(tf)
    assert tf._CACHE_SIZE == 500


# ---------------------------------------------------------------------------
# GROUP K — integration (91-92)
# ---------------------------------------------------------------------------

def test_91_filter_tools_cache_bounded(monkeypatch):
    monkeypatch.setattr(tf, 'MIN_TOOLS', 2)
    monkeypatch.setattr(tf, 'TOP_K', 1)
    tf._last_tool_sets = tf._LRUDict(5)
    tools = [_mk_tool('match', 'query match'), _mk_tool('other', 'irrelevant')]
    for i in range(600):
        msgs = [_mk_user(f'root-{i}'), _mk_user('query match')]
        tf.filter_tools(tools, msgs)
    assert len(tf._last_tool_sets) == 5


def test_92_lru_semantics_via_filter_tools(monkeypatch):
    monkeypatch.setattr(tf, 'MIN_TOOLS', 2)
    monkeypatch.setattr(tf, 'TOP_K', 1)
    tf._last_tool_sets = tf._LRUDict(3)
    tools = [_mk_tool('match', 'query match'), _mk_tool('other', 'irrelevant')]

    def call(root):
        msgs = [_mk_user(root), _mk_user('query match')]
        return tf._conversation_key(msgs)

    key_a = call('root-A'); tf.filter_tools(tools, [_mk_user('root-A'), _mk_user('query match')])
    key_b = call('root-B'); tf.filter_tools(tools, [_mk_user('root-B'), _mk_user('query match')])
    key_c = call('root-C'); tf.filter_tools(tools, [_mk_user('root-C'), _mk_user('query match')])
    # Touch A again to make it most-recent
    tf.filter_tools(tools, [_mk_user('root-A'), _mk_user('query match')])
    # Insert D — B should be evicted, not A
    key_d = call('root-D'); tf.filter_tools(tools, [_mk_user('root-D'), _mk_user('query match')])
    assert key_a in tf._last_tool_sets
    assert key_b not in tf._last_tool_sets
    assert key_c in tf._last_tool_sets
    assert key_d in tf._last_tool_sets
