/**
 * Clipboard command detection.
 *
 * Returns the ordered list of clipboard candidates for the current
 * OS + terminal environment. Consumers try each in sequence and use
 * the first that succeeds.
 *
 * Injection: pass { platform, env } to override for testing.
 */

/**
 * @typedef {{ cmd: string, args: string[] }} ClipboardCandidate
 */

/**
 * Detect ordered clipboard candidates for the current platform/terminal.
 *
 * @param {{ platform?: string, env?: Record<string, string|undefined> }} opts
 * @returns {ClipboardCandidate[]}
 */
export function detectClipboardCandidates({
  platform = process.platform,
  env = process.env,
} = {}) {
  const isWsl = platform === 'linux' &&
    Boolean(env.WSL_DISTRO_NAME || env.WSLENV || env.WSL_INTEROP);
  const isWayland = platform === 'linux' && Boolean(env.WAYLAND_DISPLAY);

  // osc52d socket candidate — inserted first when the daemon is running.
  // The daemon holds the real terminal fd (inherited before the AI process
  // starts) and writes OSC 52 clipboard sequences there, reaching the
  // terminal emulator even from within a captured AI subprocess context.
  // Client is a Python one-liner that sends text to the Unix socket.
  const osc52Candidate = buildOsc52Candidate(env);

  if (platform === 'darwin') {
    return [
      ...(osc52Candidate ? [osc52Candidate] : []),
      { cmd: 'pbcopy', args: [] },
    ];
  }

  if (platform === 'win32') {
    return [
      // clip.exe: always present on Windows, reads stdin, plain-text safe
      { cmd: 'clip', args: [] },
      // PowerShell fallback: [Console]::In reads stdin correctly in -Command mode
      // ($input is NOT reliably populated from piped stdin in -Command mode)
      { cmd: 'powershell',
        args: ['-NonInteractive', '-NoProfile', '-Command',
               '$t=[Console]::In.ReadToEnd();Set-Clipboard -Value $t'] },
    ];
  }

  if (isWsl) {
    // WSL: prefer Windows clipboard (clip.exe visible from WSL), then Linux tools
    return [
      ...(osc52Candidate ? [osc52Candidate] : []),
      { cmd: 'clip.exe', args: [] },
      { cmd: 'xclip', args: ['-selection', 'clipboard'] },
      { cmd: 'wl-copy', args: [] },
    ];
  }

  if (isWayland) {
    return [
      ...(osc52Candidate ? [osc52Candidate] : []),
      { cmd: 'wl-copy', args: [] },
      { cmd: 'xclip', args: ['-selection', 'clipboard'] },
    ];
  }

  // Linux X11 or headless
  return [
    ...(osc52Candidate ? [osc52Candidate] : []),
    { cmd: 'xclip', args: ['-selection', 'clipboard'] },
    { cmd: 'wl-copy', args: [] },
  ];
}

/**
 * Build a clipboard candidate that sends text to a running osc52d daemon via
 * its Unix-domain socket. Returns null when $OSC52_SOCKET is not set or the
 * socket path contains characters that would break the Python one-liner.
 *
 * The client is a self-contained Python one-liner so no extra binary needs to
 * be on PATH — python3 is already required to run the daemon.
 *
 * @param {Record<string, string|undefined>} env
 * @returns {{ cmd: string, args: string[] } | null}
 */
export function buildOsc52Candidate(env = process.env) {
  const socketPath = env.OSC52_SOCKET;
  if (!socketPath) return null;
  // Reject paths with single-quotes or backslashes to prevent code injection
  // in the Python literal. (Socket paths are always /tmp/osc52d-NNN.sock in
  // practice, so this guard is never triggered in normal use.)
  if (socketPath.includes("'") || socketPath.includes('\\')) return null;
  const script = [
    'import socket,sys',
    `s=socket.socket(socket.AF_UNIX)`,
    `s.connect('${socketPath}')`,
    `s.sendall(sys.stdin.buffer.read())`,
    `s.close()`,
  ].join(';');
  return { cmd: 'python3', args: ['-c', script] };
}
