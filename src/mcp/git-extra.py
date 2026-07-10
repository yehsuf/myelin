#!/usr/bin/env python3
"""
Myelin git-extra MCP server — adds git_blame and git_log_rich tools.
Speaks MCP stdio JSON-RPC protocol (no external dependencies).
"""
import json
import re
import subprocess
import sys


def _safe_path(path: str) -> str:
    """Reject path strings containing shell metacharacters."""
    if re.search(r'[;&|`$<>\\]', path):
        raise ValueError(f'Unsafe path: {path!r}')
    return path


def _safe_filter(value: str, label: str) -> str:
    if re.search(r'[;&|`$<>]', value):
        raise ValueError(f'Unsafe {label} filter')
    return value


def _run_git(cmd: list[str], label: str) -> str:
    try:
        return subprocess.check_output(cmd, text=True, timeout=15, stderr=subprocess.STDOUT)
    except subprocess.CalledProcessError as exc:
        return f'{label} failed: {exc.output}'
    except OSError as exc:
        return f'{label} failed: {exc}'


def git_blame(path: str, start_line: int | None = None, end_line: int | None = None) -> str:
    path = _safe_path(path)
    cmd = ['git', 'blame', '--porcelain']
    if start_line is not None and end_line is not None:
        cmd += ['-L', f'{int(start_line)},{int(end_line)}']
    cmd.append(path)
    return _run_git(cmd, 'git blame')


def git_log_rich(
    path: str | None = None,
    author: str | None = None,
    since: str | None = None,
    until: str | None = None,
    n: int = 20,
) -> str:
    cmd = [
        'git',
        'log',
        f'-{max(1, int(n))}',
        '--stat',
        '--format=commit %H%nauthor: %an <%ae>%ndate: %ad%nsubject: %s%n%b',
    ]
    if author:
        cmd += [f'--author={_safe_filter(author, "author")}']
    if since:
        cmd += [f'--since={_safe_filter(since, "since")}']
    if until:
        cmd += [f'--until={_safe_filter(until, "until")}']
    if path:
        cmd += ['--follow', '--', _safe_path(path)]
    return _run_git(cmd, 'git log')


TOOLS = [
    {
        'name': 'git_blame',
        'description': 'Show what revision and author last modified each line of a file. Returns annotated blame output.',
        'inputSchema': {
            'type': 'object',
            'properties': {
                'path': {'type': 'string', 'description': 'File path relative to repo root'},
                'start_line': {'type': 'integer', 'description': 'First line (1-based, inclusive)'},
                'end_line': {'type': 'integer', 'description': 'Last line (1-based, inclusive)'},
            },
            'required': ['path'],
        },
    },
    {
        'name': 'git_log_rich',
        'description': 'Show commit history with stats. Supports filtering by path, author, date range.',
        'inputSchema': {
            'type': 'object',
            'properties': {
                'path': {'type': 'string', 'description': 'Filter to commits touching this file (--follow)'},
                'author': {'type': 'string', 'description': 'Author name/email filter'},
                'since': {'type': 'string', 'description': 'Start date, e.g. "2 weeks ago" or "2024-01-01"'},
                'until': {'type': 'string', 'description': 'End date'},
                'n': {'type': 'integer', 'description': 'Max number of commits (default 20)'},
            },
        },
    },
]


def _dispatch(name: str, args: dict) -> str:
    if name == 'git_blame':
        return git_blame(args['path'], start_line=args.get('start_line'), end_line=args.get('end_line'))
    if name == 'git_log_rich':
        return git_log_rich(
            path=args.get('path'),
            author=args.get('author'),
            since=args.get('since'),
            until=args.get('until'),
            n=args.get('n', 20),
        )
    raise ValueError(f'Unknown tool: {name}')


def _handle(req: dict) -> dict:
    method = req.get('method', '')
    if method == 'initialize':
        return {
            'protocolVersion': '2024-11-05',
            'capabilities': {'tools': {}},
            'serverInfo': {'name': 'git-extra', 'version': '1.0.0'},
        }
    if method == 'tools/list':
        return {'tools': TOOLS}
    if method == 'tools/call':
        params = req.get('params', {})
        text = _dispatch(params.get('name', ''), params.get('arguments', {}))
        return {'content': [{'type': 'text', 'text': text}]}
    if method in ('notifications/initialized', 'ping'):
        return {}
    raise ValueError(f'Unknown method: {method}')


def main() -> None:
    for raw in sys.stdin:
        raw = raw.strip()
        if not raw:
            continue
        try:
            req = json.loads(raw)
        except json.JSONDecodeError:
            continue
        req_id = req.get('id')
        if req_id is None and req.get('method', '').startswith('notifications/'):
            continue
        resp: dict = {'jsonrpc': '2.0'}
        if req_id is not None:
            resp['id'] = req_id
        try:
            resp['result'] = _handle(req)
        except Exception as exc:
            resp['error'] = {'code': -32603, 'message': str(exc)}
        print(json.dumps(resp), flush=True)


if __name__ == '__main__':
    main()
