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

  if (platform === 'darwin') {
    return [
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
      { cmd: 'clip.exe', args: [] },
      { cmd: 'xclip', args: ['-selection', 'clipboard'] },
      { cmd: 'wl-copy', args: [] },
    ];
  }

  if (isWayland) {
    return [
      { cmd: 'wl-copy', args: [] },
      { cmd: 'xclip', args: ['-selection', 'clipboard'] },
    ];
  }

  // Linux X11 or headless
  return [
    { cmd: 'xclip', args: ['-selection', 'clipboard'] },
    { cmd: 'wl-copy', args: [] },
  ];
}
