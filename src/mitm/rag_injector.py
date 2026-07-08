"""
Myelin rag_injector — proxy-side code context injection.

When the LLM request does NOT include serena_* tool definitions (i.e., the
client either has no MCP config or serena is not in it), this module:

  1. Detects whether the serena-agent process is running locally.
  2. If YES:  calls serena directly via subprocess (MCP stdio protocol) and
             injects the search results as a context block in the request.
  3. If NO:   falls back to ripgrep / ast-grep for lightweight code search.

In both cases the injected context is a synthetic assistant-prefill block
appended before the current user turn — the LLM sees relevant code without
needing to call any tool.

Configuration (env vars):
  MYELIN_RAG_INJECT       default: 0 (OFF — see cache-stability note below)
  MYELIN_RAG_SNIPPETS     default: 3   (number of code snippets to inject)
  MYELIN_RAG_SNIPPET_LINES default: 30 (max lines per snippet)
  MYELIN_SERENA_TIMEOUT   default: 3   (seconds to wait for serena response)

Cache-stability note: the injected block is prepended before the LAST user
turn and is NOT persisted client-side, so it only exists in the request that
was actually sent to the provider — the client's next request re-sends its
real (uninjected) history. This means the prompt-cache write for an injected
turn diverges from what the following turn sends, forfeiting that turn's
reusable prefix. Default is OFF until this is reworked to a cache-stable
injection point (e.g. a stable system-tail block). Only relevant as a
fallback anyway — it never fires when serena tools are already present in
the request (the normal Myelin setup).

The workspace root is detected from the system message (Claude Code embeds
the cwd there) or from the first user message.
"""

import json
import os
import re
import subprocess
from pathlib import Path
from typing import Optional

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

RAG_ENABLED     = os.environ.get('MYELIN_RAG_INJECT',        '0') == '1'
MAX_SNIPPETS    = int(os.environ.get('MYELIN_RAG_SNIPPETS',         '3'))
SNIPPET_LINES   = int(os.environ.get('MYELIN_RAG_SNIPPET_LINES',   '30'))
SERENA_TIMEOUT  = float(os.environ.get('MYELIN_SERENA_TIMEOUT',     '3'))

# If serena tools appear under any of these names in the tools array,
# RAG injection is skipped (serena is already available to the LLM).
SERENA_TOOL_PREFIXES = ('serena_', 'serena-')

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _has_serena_tools(tools: list[dict]) -> bool:
    """Return True if any serena tool is already in the tools array."""
    for t in tools:
        name = t.get('name') or t.get('function', {}).get('name', '')
        if name.startswith(SERENA_TOOL_PREFIXES):
            return True
    return False


def _is_serena_running() -> bool:
    """Cross-platform check for a running serena-agent process."""
    # Try psutil first (optional dep, most reliable)
    try:
        import psutil
        for p in psutil.process_iter(['cmdline']):
            try:
                cmd = ' '.join(p.cmdline())
                if 'serena' in cmd.lower():
                    return True
            except (psutil.NoSuchProcess, psutil.AccessDenied):
                pass
        return False
    except ImportError:
        pass

    import platform
    system = platform.system()
    try:
        if system == 'Windows':
            out = subprocess.run(
                ['tasklist', '/FI', 'IMAGENAME eq serena.exe', '/FO', 'CSV'],
                capture_output=True, text=True, timeout=2,
            )
            return 'serena' in out.stdout.lower()
        else:
            out = subprocess.run(
                ['pgrep', '-f', 'serena'],
                capture_output=True, timeout=2,
            )
            return out.returncode == 0
    except Exception:
        return False


def _detect_workspace(messages: list[dict]) -> Optional[Path]:
    """
    Try to extract the workspace/project root from the system or first user message.
    Claude Code embeds something like 'Working directory: /path/to/repo' in its system prompt.
    """
    patterns = [
        r'[Ww]orking (?:directory|dir):\s*([^\n]+)',
        r'[Cc]urrent (?:directory|dir):\s*([^\n]+)',
        r'[Pp]roject (?:root|dir):\s*([^\n]+)',
        r'cwd:\s*([^\n]+)',
    ]
    for m in messages:
        text = ''
        c = m.get('content')
        if isinstance(c, str):
            text = c
        elif isinstance(c, list):
            text = ' '.join(b.get('text', '') for b in c if isinstance(b, dict))
        for pat in patterns:
            match = re.search(pat, text)
            if match:
                p = Path(match.group(1).strip())
                if p.is_dir():
                    return p
    # Fallback to cwd of the proxy process (usually the project)
    cwd = Path.cwd()
    if (cwd / '.git').exists():
        return cwd
    return None


def _extract_query(messages: list[dict]) -> str:
    """Get the last user message text as the search query."""
    for m in reversed(messages):
        if m.get('role') != 'user':
            continue
        c = m.get('content')
        if isinstance(c, str):
            return c[:500]
        if isinstance(c, list):
            parts = [b.get('text', '') for b in c if isinstance(b, dict) and b.get('type') == 'text']
            return '\n'.join(parts)[:500]
    return ''


def _extract_keywords(query: str) -> list[str]:
    """Extract likely code-relevant keywords from a user query."""
    # Remove common stopwords, keep identifiers + CamelCase + snake_case
    stopwords = {'the', 'a', 'an', 'is', 'are', 'was', 'be', 'to', 'of', 'in',
                 'how', 'what', 'why', 'where', 'when', 'can', 'do', 'does',
                 'i', 'me', 'my', 'you', 'it', 'its', 'that', 'this', 'with',
                 'and', 'or', 'for', 'on', 'at', 'by', 'from', 'into', 'about'}
    tokens = re.findall(r'[A-Za-z_][A-Za-z0-9_]{2,}', query)
    return [t for t in tokens if t.lower() not in stopwords][:8]

# ---------------------------------------------------------------------------
# Ripgrep-based search (fallback, always available)
# ---------------------------------------------------------------------------

def _rg_available() -> bool:
    try:
        subprocess.run(['rg', '--version'], capture_output=True, timeout=2)
        return True
    except Exception:
        return False

_RG_OK: Optional[bool] = None  # cached after first call

def _rg_search(query: str, workspace: Path, max_results: int = MAX_SNIPPETS) -> list[dict]:
    """Run ripgrep for keywords, return list of {file, snippet} dicts."""
    global _RG_OK
    if _RG_OK is None:
        _RG_OK = _rg_available()

    keywords = _extract_keywords(query)
    if not keywords:
        return []

    results = []
    seen: set = set()

    for kw in keywords[:4]:
        if _RG_OK:
            try:
                out = subprocess.run(
                    ['rg', '-l', '--max-count', '1', kw, str(workspace)],
                    capture_output=True, text=True, timeout=4,
                )
                paths = out.stdout.strip().splitlines()
            except Exception:
                paths = []
        else:
            # Pure-Python fallback: walk workspace looking for keyword in files
            paths = _py_grep(kw, workspace, limit=3)

        for path_str in paths:
            p = Path(path_str)
            if str(p) not in seen and p.is_file():
                seen.add(str(p))
                snippet = _read_snippet(p)
                if snippet:
                    results.append({'file': path_str, 'snippet': snippet})
                    if len(results) >= max_results:
                        return results

    return results


def _py_grep(keyword: str, workspace: Path, limit: int = 3) -> list[str]:
    """Pure-Python file search — used when ripgrep is unavailable."""
    kw_lower = keyword.lower()
    found = []
    skip_dirs = {'.git', '__pycache__', 'node_modules', '.venv', 'venv', 'dist', 'build'}
    try:
        for root, dirs, files in os.walk(workspace):
            dirs[:] = [d for d in dirs if d not in skip_dirs]
            for fname in files:
                if not fname.endswith(('.py', '.ts', '.js', '.mjs', '.go', '.java', '.rs', '.c', '.cpp')):
                    continue
                fpath = Path(root) / fname
                try:
                    if kw_lower in fpath.read_text(errors='replace').lower():
                        found.append(str(fpath))
                        if len(found) >= limit:
                            return found
                except Exception:
                    pass
    except Exception:
        pass
    return found


def _read_snippet(path: Path, max_lines: int = SNIPPET_LINES) -> str:
    """Read the first max_lines lines of a file."""
    try:
        content = path.read_text(errors='replace')
        lines = content.splitlines()[:max_lines]
        return '\n'.join(lines)
    except Exception:
        return ''

# ---------------------------------------------------------------------------
# Serena-backed search (when serena-agent is running)
# ---------------------------------------------------------------------------

def _serena_search(query: str, workspace: Path) -> list[dict]:
    """
    Call serena's search_for_pattern_in_files via MCP stdio.
    Serena is spawned as a one-shot subprocess (reuses the running daemon would
    be nicer but requires a persistent connection; for now each call is fresh).
    """
    keywords = _extract_keywords(query)
    if not keywords:
        return []

    mcp_request = {
        'jsonrpc': '2.0',
        'id': 1,
        'method': 'tools/call',
        'params': {
            'name': 'serena_search_for_pattern_in_files',
            'arguments': {
                'pattern': '|'.join(keywords[:3]),
                'file_pattern': '*.py,*.ts,*.js,*.mjs,*.go,*.java,*.rs',
                'context_lines_count': 5,
            },
        },
    }

    # First send initialize, then the tool call
    init_req = {'jsonrpc': '2.0', 'id': 0, 'method': 'initialize',
                'params': {'protocolVersion': '2024-11-05',
                           'capabilities': {},
                           'clientInfo': {'name': 'myelin', 'version': '1'}}}
    stdin_data = (
        json.dumps(init_req) + '\n' +
        json.dumps(mcp_request) + '\n'
    ).encode()

    try:
        proc = subprocess.run(
            ['serena', '--project', str(workspace)],
            input=stdin_data,
            capture_output=True,
            timeout=SERENA_TIMEOUT,
        )
        results = []
        for line in proc.stdout.splitlines():
            try:
                resp = json.loads(line)
                if resp.get('id') == 1 and 'result' in resp:
                    content = resp['result'].get('content', [])
                    for block in content:
                        if block.get('type') == 'text':
                            results.append({'file': '(serena)', 'snippet': block['text'][:SNIPPET_LINES * 80]})
            except (json.JSONDecodeError, KeyError):
                pass
        return results[:MAX_SNIPPETS]
    except Exception:
        return []

# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def should_inject(tools: list[dict]) -> bool:
    """Return True if RAG injection is appropriate for this request."""
    return RAG_ENABLED and not _has_serena_tools(tools)


def build_context_block(snippets: list[dict]) -> Optional[str]:
    """Format retrieved snippets as a brief context note for injection."""
    if not snippets:
        return None
    lines = ['[Myelin context — relevant code found locally]']
    for s in snippets:
        lines.append(f"\n--- {s['file']} ---\n{s['snippet']}")
    return '\n'.join(lines)


def inject_rag_context(data: dict) -> dict:
    """
    Main entry point. Mutates the request body dict to prepend a context
    assistant message if relevant code is found. Returns the (possibly modified) dict.
    """
    messages = data.get('messages', [])
    tools = data.get('tools', [])
    if not messages or not should_inject(tools):
        return data

    query = _extract_query(messages)
    if not query.strip():
        return data

    workspace = _detect_workspace(messages)
    if not workspace:
        return data

    # Search: serena if running, else ripgrep
    snippets = (
        _serena_search(query, workspace)
        if _is_serena_running()
        else _rg_search(query, workspace)
    )

    if not snippets:
        return data

    context_text = build_context_block(snippets)
    if not context_text:
        return data

    # Inject as a synthetic user→assistant exchange BEFORE the last user turn.
    # This keeps the conversation structure valid and the injected context
    # appears as "already known" to the LLM.
    last_user_idx = None
    for i, m in enumerate(messages):
        if m.get('role') == 'user':
            last_user_idx = i

    if last_user_idx is None or last_user_idx == 0:
        return data  # no safe injection point

    context_msg = {
        'role': 'assistant',
        'content': context_text,
    }
    new_messages = (
        messages[:last_user_idx] +
        [context_msg] +
        messages[last_user_idx:]
    )
    return {**data, 'messages': new_messages}
