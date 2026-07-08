import { execSync } from 'node:child_process';
import { writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const REG_RUN = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const HEADROOM_KEY  = 'MyelinHeadroom';
const MITM_KEY      = 'MyelinMitmproxy';

function runPs(script) {
  const tmp = join(tmpdir(), `myelin-${Date.now()}.ps1`);
  writeFileSync(tmp, script, 'utf8');
  try {
    execSync(`powershell -ExecutionPolicy Bypass -File "${tmp}"`, { stdio: 'pipe' });
  } finally {
    try { unlinkSync(tmp); } catch {}
  }
}

/** Pure builder — returns the PowerShell script text without executing it. */
export function generateHeadroomRunScript({ headroomBin, port }) {
  const bin = headroomBin.replace(/\//g, '\\');
  // Kill any existing headroom process, start fresh hidden, persist via registry
  return `
Stop-Process -Name headroom -ErrorAction SilentlyContinue
Start-Sleep -Milliseconds 500
Start-Process -FilePath '${bin}' -ArgumentList 'proxy --port ${port}' -WindowStyle Hidden
Set-ItemProperty -Path '${REG_RUN}' -Name '${HEADROOM_KEY}' -Value '"${bin}" proxy --port ${port}'
Write-Host "[myelin] headroom started (hidden)"
`;
}

export function installService({ headroomBin, port }) {
  runPs(generateHeadroomRunScript({ headroomBin, port }));
}

/** Pure builder — returns the PowerShell script text without executing it. */
export function generateMitmRunScript({ mitmdumpBin, port, addonPath, envVars = {} }) {
  const bin   = mitmdumpBin.replace(/\//g, '\\');
  const addon = addonPath.replace(/\//g, '\\');
  const ca    = (envVars.SSL_CERT_FILE || envVars.REQUESTS_CA_BUNDLE || envVars.NODE_EXTRA_CA_CERTS || '').replace(/\//g, '\\');
  const caArg    = ca ? ` --set ssl_verify_upstream_trusted_ca="${ca}"` : '';
  const proxyArg = (envVars.HTTPS_PROXY && !envVars.HTTPS_PROXY.includes('127.0.0.1') && !envVars.HTTPS_PROXY.includes('localhost')) ? ` --mode upstream:${envVars.HTTPS_PROXY}` : '';
  const args     = `--listen-port ${port} -s "${addon}"${proxyArg}${caArg}`;
  const envLines = Object.entries(envVars)
    .map(([k, v]) => `[System.Environment]::SetEnvironmentVariable('${k}', '${v.replace(/\\/g, '\\\\')}', 'User')`)
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
