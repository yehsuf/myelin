import { execSync } from 'node:child_process';
import { writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const REG_RUN = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const HEADROOM_KEY  = 'MyelinHeadroom';
const MITM_KEY      = 'MyelinMitmproxy';
const COPILOT_HEADROOM_KEY = 'MyelinCopilotHeadroom';

function runPs(script) {
  const tmp = join(tmpdir(), `myelin-${Date.now()}.ps1`);
  writeFileSync(tmp, script, 'utf8');
  try {
    execSync(`powershell -ExecutionPolicy Bypass -File "${tmp}"`, { stdio: 'pipe' });
  } finally {
    try { unlinkSync(tmp); } catch {}
  }
}

/** Build a PowerShell snippet that stops only the process instance whose
 *  command line matches a specific --port value (not all processes sharing
 *  the same binary name) — needed once more than one headroom instance can
 *  run at once (Claude-Headroom + Copilot-Headroom both run headroom.exe).
 *  NOT live-tested on Windows (Mac is this project's primary dev/test
 *  platform) — review carefully before relying on it in production.
 */
function stopByPortScript(processExeName, port) {
  return `Get-CimInstance Win32_Process -Filter "Name = '${processExeName}'" | Where-Object { $_.CommandLine -like '*--port ${port}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`;
}

/** Pure builder — returns the PowerShell script text without executing it. */
export function generateHeadroomRunScript({ headroomBin, port, interceptToolResults }) {
  const bin = headroomBin.replace(/\//g, '\\');
  const exeName = bin.split('\\').pop();
  const extraArgs = interceptToolResults ? ' --intercept-tool-results' : '';
  // Kill only the existing instance on this exact port, start fresh hidden, persist via registry
  return `
${stopByPortScript(exeName, port)}
Start-Sleep -Milliseconds 500
Start-Process -FilePath '${bin}' -ArgumentList 'proxy --port ${port}${extraArgs}' -WindowStyle Hidden
Set-ItemProperty -Path '${REG_RUN}' -Name '${HEADROOM_KEY}' -Value '"${bin}" proxy --port ${port}${extraArgs}'
Write-Host "[myelin] headroom started (hidden)"
`;
}

export function installService({ headroomBin, port, interceptToolResults }) {
  runPs(generateHeadroomRunScript({ headroomBin, port, interceptToolResults }));
}

/**
 * Pure builder — returns the PowerShell script text for the dedicated
 * Copilot-Headroom instance (distinct from the Claude-Headroom instance
 * above). Gives it its own working directory (via Set-Location before
 * Start-Process) so its memory/cache/stats state never collides with the
 * Claude-Headroom instance's own state (headroom has no dedicated
 * HEADROOM_HOME-style env var — WorkingDirectory/cwd is the isolation
 * mechanism, matching the launchd.mjs implementation).
 * NOT live-tested on Windows — review carefully before relying on it.
 */
export function generateCopilotHeadroomRunScript({ headroomBin, port, mode, workingDirectory, envVars = {} }) {
  const bin = headroomBin.replace(/\//g, '\\');
  const exeName = bin.split('\\').pop();
  const workDir = (workingDirectory ?? '').replace(/\//g, '\\');
  const args = `proxy --port ${port} --mode ${mode ?? 'cache'} --connect-timeout-seconds 10`;
  const envLines = Object.entries(envVars)
    .map(([k, v]) => `[System.Environment]::SetEnvironmentVariable('${k}', '${String(v ?? '').replace(/'/g, "''")}', 'Process')`)
    .join('\n');
  return `
${envLines}
New-Item -ItemType Directory -Force -Path '${workDir}' | Out-Null
${stopByPortScript(exeName, port)}
Start-Sleep -Milliseconds 500
Start-Process -FilePath '${bin}' -ArgumentList '${args}' -WorkingDirectory '${workDir}' -WindowStyle Hidden
Set-ItemProperty -Path '${REG_RUN}' -Name '${COPILOT_HEADROOM_KEY}' -Value '"${bin}" ${args}'
Write-Host "[myelin] copilot-headroom started (hidden)"
`;
}

export function installCopilotHeadroomService({ headroomBin, port, envVars = {}, home }) {
  const workingDirectory = join(home ?? process.env.USERPROFILE ?? '.', '.myelin', 'copilot-headroom');
  runPs(generateCopilotHeadroomRunScript({ headroomBin, port, mode: envVars.HEADROOM_MODE, workingDirectory, envVars }));
}

export function copilotHeadroomServiceStatus() {
  try {
    const out = execSync(`powershell -Command "Get-CimInstance Win32_Process -Filter \\"Name = 'headroom.exe'\\" | Where-Object { $_.CommandLine -like '*copilot-headroom*' -or $_.CommandLine -like '*--port 8788*' } | Select-Object -First 1 -ExpandProperty ProcessId"`, { stdio: 'pipe' }).toString().trim();
    return { running: !!out, state: out ? 'Running' : 'Stopped' };
  } catch {
    return { running: false, state: 'Unknown' };
  }
}

/** Pure builder — returns the PowerShell script text without executing it.
 *  When egressPort is provided, mitmdump gets a SECOND --mode regular@PORT
 *  listener (egress-only leg for a dedicated Copilot-Headroom instance's
 *  own outbound calls) instead of --listen-port. See launchd.mjs for the
 *  same dual-listener design on macOS.
 */
/**
 * Undo any accumulated backslash-doubling corruption before persisting a
 * value via SetEnvironmentVariable, without breaking a legitimate UNC path
 * prefix (`\\server\share`, which genuinely starts with two backslashes).
 * Collapses any run of 2+ consecutive backslashes elsewhere in the string
 * down to exactly one. Self-healing: if a previously-corrupted value is
 * ever read back out of the registry and re-persisted through this path,
 * it gets fixed rather than doubled again.
 */
export function collapseRedundantBackslashes(value) {
  const str = String(value ?? '');
  const uncPrefix = str.startsWith('\\\\') ? '\\\\' : '';
  const rest = str.slice(uncPrefix.length);
  return uncPrefix + rest.replace(/\\{2,}/g, '\\');
}

export function generateMitmRunScript({ mitmdumpBin, port, addonPath, envVars = {}, egressPort }) {
  const bin   = mitmdumpBin.replace(/\//g, '\\');
  const addon = addonPath.replace(/\//g, '\\');
  const ca    = (envVars.SSL_CERT_FILE || envVars.REQUESTS_CA_BUNDLE || envVars.NODE_EXTRA_CA_CERTS || '').replace(/\//g, '\\');
  const caArg    = ca ? ` --set ssl_verify_upstream_trusted_ca="${ca}"` : '';
  const proxyArg = (envVars.HTTPS_PROXY && !envVars.HTTPS_PROXY.includes('127.0.0.1') && !envVars.HTTPS_PROXY.includes('localhost')) ? ` --mode upstream:${envVars.HTTPS_PROXY}` : '';
  const listenArg = egressPort ? `--mode regular@${port} --mode regular@${egressPort}` : `--listen-port ${port}`;
  const args     = `${listenArg} -s "${addon}"${proxyArg}${caArg}`;
  const envLines = Object.entries({
    ...(egressPort ? { MYELIN_EGRESS_PORT: String(egressPort) } : {}),
    ...envVars,
  })
    // PowerShell single-quoted strings are literal - backslashes never need
    // escaping there (only a literal single-quote doubles: ' -> ''). This
    // line previously doubled every backslash unconditionally, which is
    // wrong on its own, and because this script persists to the registry
    // (User scope) and gets read back as input on the next run, it silently
    // compounded across restarts: one clean path became doubled, then
    // quadrupled, then octupled backslashes over successive `myelin
    // restart`/install runs - observed live as a NetFree CA path corrupted
    // to 8 backslashes per separator. collapseRedundantBackslashes() both
    // stops the bug and self-heals any value that was already corrupted by
    // it in a prior run.
    .map(([k, v]) => `[System.Environment]::SetEnvironmentVariable('${k}', '${collapseRedundantBackslashes(v).replace(/'/g, "''")}', 'User')`)
    .join('\n');
  return `
${envLines}
Stop-Process -Name mitmdump -ErrorAction SilentlyContinue
Start-Sleep -Milliseconds 500
Start-Process -FilePath '${bin}' -ArgumentList '${args}' -WindowStyle Hidden
Set-ItemProperty -Path '${REG_RUN}' -Name '${MITM_KEY}' -Value '"${bin}" ${args}'
Write-Host "[myelin] mitmproxy started (hidden)"
`;
}

export function installMitmService(opts) {
  runPs(generateMitmRunScript(opts));
}

export function mitmServiceStatus() {
  try {
    const out = execSync(`powershell -Command "Get-Process mitmdump -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty Id"`, { stdio: 'pipe' }).toString().trim();
    return { running: !!out, state: out ? 'Running' : 'Stopped' };
  } catch {
    return { running: false, state: 'Unknown' };
  }
}

export function serviceStatus() {
  try {
    const out = execSync(`powershell -Command "Get-Process headroom -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty Id"`, { stdio: 'pipe' }).toString().trim();
    return { running: !!out, state: out ? 'Running' : 'Stopped' };
  } catch {
    return { running: false, state: 'Unknown' };
  }
}

/**
 * Pure builder — returns PowerShell script text that persists environment
 * variables via the registry (HKCU\Environment, through .NET's
 * [Environment]::SetEnvironmentVariable(..., 'User')). This is what lets
 * new PowerShell/cmd windows pick up HEADROOM_PORT/ANTHROPIC_BASE_URL/CA
 * bundle vars automatically WITHOUT ever touching $PROFILE — critical on
 * machines where Windows Defender's Controlled Folder Access blocks writes
 * into Documents\WindowsPowerShell (confirmed live: $PROFILE always
 * resolves there, and CFA silently blocks New-Item/Add-Content into it
 * with no thrown error, even with full NTFS control). A registry write
 * via .NET isn't a protected-folder filesystem write, so CFA doesn't apply.
 *
 * Only single-quotes need escaping in PowerShell single-quoted strings
 * (double them) — backslashes are literal and must NOT be doubled (a
 * mistake made and fixed earlier in this same file's history).
 */
export function generateSetUserEnvVarsScript(vars) {
  return Object.entries(vars)
    // collapseRedundantBackslashes here too so a value corrupted by the
    // sibling generateMitmRunScript bug (fixed above) self-heals wherever
    // it happens to be re-persisted from, not just at its original source.
    .map(([k, v]) => `[Environment]::SetEnvironmentVariable('${k}', '${collapseRedundantBackslashes(v).replace(/'/g, "''")}', 'User')`)
    .join('\n') + '\n';
}

/** Persist env vars to the registry so new sessions inherit them without $PROFILE. */
export function setUserEnvVars(vars) {
  try {
    runPs(generateSetUserEnvVarsScript(vars));
    return true;
  } catch {
    return false;
  }
}
