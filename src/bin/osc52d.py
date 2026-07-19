#!/usr/bin/env python3
"""
osc52d — compact clipboard daemon for Myelin.

Listens on a Unix-domain socket for clipboard write requests and relays them
to the terminal via OSC 52 escape sequences.

The daemon must be started from the REAL shell (before launching Copilot or
Claude) so it inherits the real terminal's stdout file descriptor.  Clients
inside the AI subprocess (e.g. compact-prepare.mjs) connect to the socket and
send text; the daemon writes the OSC 52 sequence to its stdout — the actual
PTY — where the terminal emulator (iTerm2, WezTerm, kitty …) picks it up and
writes the content to the system clipboard.

Socket path: $OSC52_SOCKET or /tmp/osc52d-<uid>.sock
Protocol:    raw bytes (UTF-8 text) over a SOCK_STREAM connection; the daemon
             reads until EOF, then writes one OSC 52 sequence.

Usage (in shell wrapper, before the AI process):
    python3 ~/.myelin/current/src/bin/osc52d.py &
    export OSC52_SOCKET=/tmp/osc52d-$(id -u).sock

"""
import base64
import os
import signal
import socket
import sys

SOCKET_PATH: str = os.environ.get('OSC52_SOCKET', f'/tmp/osc52d-{os.getuid()}.sock')
_RECV_SIZE = 65536


def write_osc52(text: str) -> None:
    """Write an OSC 52 clipboard sequence to inherited stdout (the real tty)."""
    b64 = base64.b64encode(text.encode('utf-8')).decode('ascii')
    # OSC 52 ; primary selection 'c' ; base64 payload ; BEL terminator
    sys.stdout.write(f'\033]52;c;{b64}\a')
    sys.stdout.flush()


def handle_client(conn: socket.socket) -> None:
    chunks: list[bytes] = []
    with conn:
        while True:
            chunk = conn.recv(_RECV_SIZE)
            if not chunk:
                break
            chunks.append(chunk)
    text = b''.join(chunks).decode('utf-8', errors='replace')
    if text:
        write_osc52(text)


def main() -> None:
    # Remove any stale socket from a previous run.
    try:
        os.unlink(SOCKET_PATH)
    except FileNotFoundError:
        pass

    def _cleanup(_sig: int, _frame: object) -> None:
        try:
            os.unlink(SOCKET_PATH)
        except FileNotFoundError:
            pass
        sys.exit(0)

    signal.signal(signal.SIGTERM, _cleanup)
    signal.signal(signal.SIGHUP, _cleanup)

    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as srv:
        srv.bind(SOCKET_PATH)
        os.chmod(SOCKET_PATH, 0o600)
        srv.listen(8)
        while True:
            try:
                conn, _ = srv.accept()
                handle_client(conn)
            except (KeyboardInterrupt, SystemExit):
                break
            except Exception:
                pass  # ignore individual client errors; keep serving

    try:
        os.unlink(SOCKET_PATH)
    except FileNotFoundError:
        pass


if __name__ == '__main__':
    main()
