import { execSync } from 'node:child_process';
import { writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TASK_NAME      = 'TokenstackHeadroom';
const MITM_TASK_NAME = 'MyelinMitmproxy';

/** Run a multi-line PowerShell script via temp file — avoids all inline quoting issues */
function runPs(script) {
  const tmp = join(tmpdir(), `myelin-${Date.now()}.ps1`);
  writeFileSync(tmp, script, 'utf8');
  try {
    execSync(`powershell -ExecutionPolicy Bypass -File "${tmp}"`, { stdio: 'inherit' });
  } finally {
    try { unlinkSync(tmp); } catch {}
  }
}

export function installService(opts) {
  // Skip re-registration if headroom is already running
  try {
    const pid = execSync(`powershell -Command "Get-Process headroom -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty Id"`, { stdio: 'pipe' }).toString().trim();
    if (pid) { return; } // already running, no need to re-register
  } catch {}

  const bin = opts.headroomBin.replace(/\//g, '\\');
  runPs(`
$action   = New-ScheduledTaskAction -Execute 'powershell.exe' \`
              -Argument '-WindowStyle Hidden -ExecutionPolicy Bypass -Command "& ''${bin}'' proxy --port ${opts.port}"'
$trigger  = New-ScheduledTaskTrigger -AtLogon -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopOnIdleEnd \`
              -RestartInterval (New-TimeSpan -Minutes 1) -RestartCount 999 \`
              -ExecutionTimeLimit (New-TimeSpan -Hours 0) -Hidden
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -RunLevel Limited
Unregister-ScheduledTask -TaskName '${TASK_NAME}' -Confirm:$false -ErrorAction SilentlyContinue
Register-ScheduledTask -TaskName '${TASK_NAME}' -Action $action -Trigger $trigger -Settings $settings -Principal $principal
Start-ScheduledTask -TaskName '${TASK_NAME}'
`);
}

export function installMitmService({ mitmdumpBin, port, addonPath, envVars = {} }) {
  // Skip re-registration if mitmdump is already running
  try {
    const pid = execSync(`powershell -Command "Get-Process mitmdump -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty Id"`, { stdio: 'pipe' }).toString().trim();
    if (pid) { return; }
  } catch {}

  const bin   = mitmdumpBin.replace(/\//g, '\\');
  const addon = addonPath.replace(/\//g, '\\');
  const ca    = (envVars.SSL_CERT_FILE || envVars.REQUESTS_CA_BUNDLE || envVars.NODE_EXTRA_CA_CERTS || '').replace(/\//g, '\\');
  const caArg    = ca ? ` --set ssl_verify_upstream_trusted_ca="${ca}"` : '';
  const proxyArg = envVars.HTTPS_PROXY ? ` --mode upstream:${envVars.HTTPS_PROXY}` : '';
  const envLines = Object.entries(envVars)
    .map(([k, v]) => `[System.Environment]::SetEnvironmentVariable('${k}', '${v.replace(/\\/g, '\\\\')}', 'User')`)
    .join('\n');
  runPs(`
${envLines}
$action   = New-ScheduledTaskAction -Execute 'powershell.exe' \`
              -Argument '-WindowStyle Hidden -ExecutionPolicy Bypass -Command "& ''${bin}'' --listen-port ${port} -s ''${addon}''${proxyArg}${caArg}"'
$trigger  = New-ScheduledTaskTrigger -AtLogon -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopOnIdleEnd \`
              -RestartInterval (New-TimeSpan -Minutes 1) -RestartCount 999 \`
              -ExecutionTimeLimit (New-TimeSpan -Hours 0) -Hidden
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -RunLevel Limited
Unregister-ScheduledTask -TaskName '${MITM_TASK_NAME}' -Confirm:$false -ErrorAction SilentlyContinue
Register-ScheduledTask -TaskName '${MITM_TASK_NAME}' -Action $action -Trigger $trigger -Settings $settings -Principal $principal
Start-ScheduledTask -TaskName '${MITM_TASK_NAME}'
Write-Host "[myelin] mitmproxy task state: Running"
`);
}

export function mitmServiceStatus() {
  try {
    // Check if mitmdump process is actually running (task state is unreliable on Windows)
    const out = execSync(`powershell -Command "Get-Process mitmdump -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty Id"`, { stdio: 'pipe' }).toString().trim();
    return { running: !!out, state: out ? 'Running' : 'Stopped' };
  } catch {
    return { running: false, state: 'Unknown' };
  }
}

export function serviceStatus() {
  try {
    // Check if headroom process is actually running (task state is unreliable on Windows)
    const out = execSync(`powershell -Command "Get-Process headroom -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty Id"`, { stdio: 'pipe' }).toString().trim();
    return { running: !!out, state: out ? 'Running' : 'Stopped' };
  } catch {
    return { running: false, state: 'Unknown' };
  }
}
