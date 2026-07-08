"""
Myelin tool_filter — proxy-level tool relevance filtering.

Scores the tools[] array in an LLM request against the last user message and
removes low-relevance tools before forwarding. Works at the HTTP layer —
no MCP, no client changes, provider-agnostic.

Strategy:
  1. BM25 keyword scoring (stdlib only — always available, instant).
  2. Optional model2vec semantic scoring (if installed; ~1-2 ms per query).
  3. Hybrid: RRF of both when both available.

Tools below the relevance threshold are physically removed from the array.
To avoid busting the prompt cache on every turn, the filtered set is
stabilised: tools are only changed when the filtered set differs from the
previous turn's set (epsilon threshold on embedding drift).

Always-on tools are never filtered regardless of relevance score.

Configuration (env vars):
  MYELIN_TOOL_FILTER         default: 1   (set 0 to disable)
  MYELIN_TOOL_FILTER_TOP_K   default: 10  (max tools to keep, plus always-on)
  MYELIN_TOOL_FILTER_MIN     default: 15  (minimum tool count to bother filtering)
"""

import hashlib
import json
import math
import os
import re
from collections import Counter
from typing import Optional

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

FILTER_ENABLED = os.environ.get('MYELIN_TOOL_FILTER', '1') == '1'
TOP_K          = int(os.environ.get('MYELIN_TOOL_FILTER_TOP_K', '10'))
MIN_TOOLS      = int(os.environ.get('MYELIN_TOOL_FILTER_MIN', '15'))

# Tools that are never removed — core agent primitives that must always be present.
ALWAYS_ON: frozenset = frozenset({
    # Claude Code / Copilot core
    'Read', 'Write', 'Edit', 'MultiEdit', 'Bash', 'Grep', 'Glob',
    'TodoRead', 'TodoWrite', 'Task', 'WebSearch', 'WebFetch',
    # Copilot-specific
    'get_file_content', 'create_file', 'replace_string_in_file',
    'run_in_terminal', 'ask_user', 'task_complete',
    # Myelin-injected
    'tool_search', 'code_search', 'serena_find_symbol',
})

# ---------------------------------------------------------------------------
# Optional model2vec import
# ---------------------------------------------------------------------------

try:
    from model2vec import StaticModel as _M2V
    _MODEL = _M2V.from_pretrained('minishlab/potion-retrieval-32M')
    _HAS_M2V = True
except Exception:
    _MODEL = None
    _HAS_M2V = False

# ---------------------------------------------------------------------------
# BM25 implementation (pure stdlib)
# ---------------------------------------------------------------------------

def _tokenise(text: str) -> list[str]:
    return re.findall(r'[a-z0-9]+', text.lower())

def _humanise_name(name: str) -> str:
    name = re.sub(r'([a-z0-9])([A-Z])', r'\1 \2', name)
    return re.sub(r'[_\-./]+', ' ', name)

def _tool_text(tool: dict) -> str:
    """Human-readable text representation of a tool for scoring."""
    parts = [_humanise_name(tool.get('name', ''))]
    desc = tool.get('description') or tool.get('function', {}).get('description', '')
    if desc:
        parts.append(desc)
    return ' '.join(parts)

class _BM25:
    """Minimal BM25 scorer — no external deps."""
    k1: float = 1.5
    b: float  = 0.75

    def __init__(self, docs: list[list[str]]):
        self.n = len(docs)
        self.avgdl = sum(len(d) for d in docs) / max(self.n, 1)
        self.df: Counter = Counter()
        self.docs = docs
        for d in docs:
            for t in set(d):
                self.df[t] += 1

    def score(self, query_tokens: list[str], doc_idx: int) -> float:
        doc = self.docs[doc_idx]
        dl = len(doc)
        tf = Counter(doc)
        s = 0.0
        for t in query_tokens:
            if t not in tf:
                continue
            idf = math.log((self.n - self.df[t] + 0.5) / (self.df[t] + 0.5) + 1)
            tf_norm = tf[t] * (self.k1 + 1) / (tf[t] + self.k1 * (1 - self.b + self.b * dl / self.avgdl))
            s += idf * tf_norm
        return s

    def rank(self, query: str, k: int) -> list[int]:
        qt = _tokenise(query)
        if not qt:
            return list(range(min(k, self.n)))
        scores = [(i, self.score(qt, i)) for i in range(self.n)]
        scores.sort(key=lambda x: -x[1])
        return [i for i, _ in scores[:k]]

# ---------------------------------------------------------------------------
# Hybrid RRF (Reciprocal Rank Fusion)
# ---------------------------------------------------------------------------

def _rrf(rank_lists: list[list[int]], k: int = 60) -> list[int]:
    scores: dict[int, float] = {}
    for ranks in rank_lists:
        for pos, idx in enumerate(ranks):
            scores[idx] = scores.get(idx, 0.0) + 1.0 / (k + pos + 1)
    return sorted(scores, key=lambda x: -scores[x])

# ---------------------------------------------------------------------------
# Embedding scoring (model2vec, optional)
# ---------------------------------------------------------------------------

def _embed_score(query: str, texts: list[str]) -> list[float]:
    """Return cosine similarity scores. Requires model2vec."""
    if not _HAS_M2V or not texts:
        return [0.0] * len(texts)
    import numpy as np
    vecs = _MODEL.encode([query] + texts)
    q, doc_vecs = vecs[0], vecs[1:]
    # potion-retrieval vectors are L2-normalised → cosine ≈ dot
    return list(doc_vecs @ q)

# ---------------------------------------------------------------------------
# Cache: last tool set per conversation (keyed by first-message hash)
# Avoids re-serialising tools when the filtered set hasn't changed → cache hit.
# ---------------------------------------------------------------------------

_last_tool_sets: dict[str, frozenset[str]] = {}  # conversation_key → tool names

def _conversation_key(messages: list[dict]) -> str:
    """Stable key for a conversation thread."""
    first = messages[0] if messages else {}
    payload = json.dumps(first, sort_keys=True)
    return hashlib.md5(payload.encode()).hexdigest()[:12]

# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def last_user_text(messages: list[dict]) -> str:
    """Extract the most recent user message text."""
    for m in reversed(messages):
        if m.get('role') != 'user':
            continue
        c = m.get('content')
        if isinstance(c, str):
            return c
        if isinstance(c, list):
            parts = [b.get('text', '') for b in c if isinstance(b, dict) and b.get('type') == 'text']
            if parts:
                return '\n'.join(parts)
    return ''

def _referenced_tool_names(messages: list[dict]) -> set[str]:
    """Tool names referenced by a `tool_use` block anywhere in the visible
    history. These must never be dropped by filtering: if a later turn's
    tools[] omits a tool the model already invoked (visible in history),
    providers may hard-reject the request (unrecognised tool reference) or
    the model may hallucinate a call to a now-absent tool."""
    names = set()
    for m in messages:
        c = m.get('content')
        if isinstance(c, list):
            for b in c:
                if isinstance(b, dict) and b.get('type') == 'tool_use' and b.get('name'):
                    names.add(b['name'])
    return names

def filter_tools(tools: list[dict], messages: list[dict]) -> tuple[list[dict], bool]:
    """
    Filter tools to the most relevant subset.

    Returns (filtered_tools, changed) where changed=True means the set
    differs from the previous turn (caller should update the request body).

    Always-on tools and any tool referenced by a prior `tool_use` block in
    the visible history are kept regardless of score.
    If fewer than MIN_TOOLS tools total, returns original unchanged.
    """
    if not FILTER_ENABLED or len(tools) < MIN_TOOLS:
        return tools, False

    query = last_user_text(messages)
    referenced = _referenced_tool_names(messages)
    always_on = [t for t in tools if t.get('name') in ALWAYS_ON]
    candidates = [t for t in tools if t.get('name') not in ALWAYS_ON]

    if not candidates or not query.strip():
        return tools, False

    texts = [_tool_text(t) for t in candidates]
    doc_tokens = [_tokenise(t) for t in texts]
    bm25 = _BM25(doc_tokens)
    bm25_ranks = bm25.rank(query, len(candidates))

    if _HAS_M2V:
        scores = _embed_score(query, texts)
        embed_ranks = sorted(range(len(candidates)), key=lambda i: -scores[i])
        ranked = _rrf([bm25_ranks, embed_ranks])
    else:
        ranked = bm25_ranks

    top_indices = set(ranked[:TOP_K])
    # Kept-name set = always-on ∪ BM25 top-K ∪ anything already referenced by
    # a tool_use block in the visible history (the mutation guard above).
    # Referenced tools bypass the top-K limit entirely — correctness (never
    # orphan a dangling tool_use/tool_result reference) takes priority over
    # the token savings from strictly enforcing TOP_K.
    keep_names = {t.get('name') for t in always_on} \
        | {candidates[i]['name'] for i in top_indices} \
        | referenced
    # Emit ALL kept tools in their ORIGINAL declaration order (not BM25
    # relevance order, and not "always_on then selected" concatenation), so
    # the serialized tools[] block stays maximally byte-stable across turns
    # and never diverges from the client's own native ordering. tools[] sits
    # at the very front of the provider cache prefix (Anthropic:
    # tools -> system -> messages), so any reordering here — even with an
    # identical set — busts the entire downstream cache. Relevance ranking
    # only decides WHICH additional tools make top-K.
    filtered = [t for t in tools if t.get('name') in keep_names]

    # Stability check: only signal changed if the name-set actually differs
    conv_key = _conversation_key(messages)
    new_names = frozenset(t.get('name') for t in filtered)
    changed = new_names != _last_tool_sets.get(conv_key)
    _last_tool_sets[conv_key] = new_names

    return filtered, changed
