import { createServer } from 'node:net';
import { execFileSync } from 'node:child_process';

export function isPortFree(port) {
  if (!port || port < 1) return Promise.resolve(false);
  return new Promise(resolve => {
    const s = createServer();
    s.once('error', () => resolve(false));
    s.once('listening', () => { s.close(); resolve(true); });
    s.listen(port, '127.0.0.1');
  });
}

export async function findFreePort(start = 8787, end = 8900) {
  for (let p = start; p <= end; p++) {
    if (await isPortFree(p)) return p;
  }
  throw new Error(`No free port found in range ${start}-${end}`);
}

/**
 * Returns the PID and command of the process listening on the given TCP port,
 * or null if the port is free or the holder cannot be identified.
 * Never throws — probe errors return null (fail-open).
 *
 * @param {number} port
 * @param {{ platform?: string, execFileSyncImpl?: Function }} opts
 * @returns {{ pid: number, cmd: string } | null}
 */
export function getPortHolder(port, {
  platform = process.platform,
  execFileSyncImpl = execFileSync,
} = {}) {
  if (!port || port < 1) return null;
  try {
    if (platform === 'win32') {
      // On WSL, platform is passed as 'win32' by the caller (the Windows-managed
      // engine process lives in the Windows network namespace). Use netstat.exe
      // via the WSL interop path so we actually query Windows — bare 'netstat'
      // on WSL would invoke Linux net-tools (different flags, LISTEN ≠ LISTENING).
      const netstatBin = process.platform === 'linux'
        ? '/mnt/c/Windows/System32/netstat.exe'  // WSL: use Windows binary
        : 'netstat';                               // native Windows: use PATH
      const out = String(execFileSyncImpl(
        netstatBin, ['-ano', '-p', 'TCP'],
        { stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000 },
      ));
      const portStr = `:${port} `;
      for (const line of out.split('\n')) {
        // Normalize CRLF; check for :PORT in local address column and LISTENING state
        const normalized = line.replace(/\r/g, '');
        if (!normalized.includes(portStr) || !normalized.includes('LISTENING')) continue;
        const pid = parseInt(normalized.trim().split(/\s+/).pop(), 10);
        if (!Number.isInteger(pid) || pid <= 0) continue;
        let cmd = '';
        try {
          // Use PowerShell to get the full command line (including script path) so
          // node.exe processes running myelin scripts are correctly identified.
          // tasklist only returns the image name (node.exe) — not enough to verify.
          const psBin = process.platform === 'linux'
            ? '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe'
            : 'powershell';
          cmd = String(execFileSyncImpl(
            psBin,
            ['-NoProfile', '-Command',
             `(Get-WmiObject Win32_Process -Filter "ProcessId = ${pid}" | Select-Object -ExpandProperty CommandLine)`],
            { stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 },
          )).trim();
        } catch { /* best-effort — cmd stays empty */ }
        return { pid, cmd: cmd.trim() };
      }
      return null;
    }

    // POSIX (macOS + Linux): lsof -nP -iTCP:<port> -sTCP:LISTEN -F pc
    // lsof -F pc emits blocks of p<pid>/c<cmd> lines — one block per process.
    // We collect ALL holders and return the first foreign one (or the last myelin
    // one if all are ours). For the common single-listener case this is identical.
    const out = String(execFileSyncImpl(
      'lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-F', 'pc'],
      { stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000 },
    ));
    const holders = [];
    let curPid = null;
    let curCmd = '';
    for (const line of out.split('\n')) {
      if (line.startsWith('p')) {
        if (curPid !== null) holders.push({ pid: curPid, cmd: curCmd });
        curPid = parseInt(line.slice(1), 10);
        curCmd = '';
      } else if (line.startsWith('c')) {
        curCmd = line.slice(1).trim();
      }
    }
    if (curPid !== null) holders.push({ pid: curPid, cmd: curCmd });
    if (holders.length === 0) return null;
    // Return first entry — in virtually all real cases there's only one LISTEN holder.
    // If multiple, caller checks isHolderMyelinManaged; returning first is conservative.
    const valid = holders.find(h => Number.isInteger(h.pid) && h.pid > 0);
    return valid ?? null;
  } catch {
    return null; // tool not available or timed out — fail-open
  }
}

/**
 * Returns true if the process holding the port appears to be myelin-managed
 * (its command path includes the myelin home directory or known myelin binary names).
 *
 * @param {{ pid: number, cmd: string } | null} holder
 * @param {string} myelinHome  ~/.myelin root
 */
export function isHolderMyelinManaged(holder, myelinHome) {
  if (!holder) return false;
  const cmd = String(holder.cmd ?? '').toLowerCase().replace(/\\/g, '/');
  const home = String(myelinHome ?? '').toLowerCase().replace(/\\/g, '/');
  // Matches managed binary paths and known service names
  return cmd.includes(home) ||
    cmd.includes('.myelin') ||
    // Known managed binary filenames that only myelin places on PATH:
    // mitmdump is always the managed mitmproxy — not a user-installed tool.
    /(?:^|[\s/\\])mitmdump(?:[\s/\\]|$|\.exe)/.test(cmd);
}
