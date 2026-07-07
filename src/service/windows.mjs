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
  const bin = opts.headroomBin.replace(/\//g, '\\');
  runPs(`
$action   = New-ScheduledTaskAction -Execute '${bin}' -Argument 'proxy --port ${opts.port}'
$trigger  = New-ScheduledTaskTrigger -AtLogon -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopOnIdleEnd \`
              -RestartInterval (New-TimeSpan -Minutes 1) -RestartCount 999 \`
              -ExecutionTimeLimit (New-TimeSpan -Hours 0)
Unregister-ScheduledTask -TaskName '${TASK_NAME}' -Confirm:$false -ErrorAction SilentlyContinue
Register-ScheduledTask -TaskName '${TASK_NAME}' -Action $action -Trigger $trigger -Settings $settings
Start-ScheduledTask -TaskName '${TASK_NAME}'
Start-Sleep -Seconds 3
$state = (Get-ScheduledTask -TaskName '${TASK_NAME}' -ErrorAction SilentlyContinue).State
Write-Host "[myelin] headroom task state: $state"
`);
}

export function installMitmService({ mitmdumpBin, port, addonPath, envVars = {} }) {
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
$action   = New-ScheduledTaskAction -Execute '${bin}' -Argument '--listen-port ${port} -s "${addon}"${proxyArg}${caArg}'
$trigger  = New-ScheduledTaskTrigger -AtLogon -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopOnIdleEnd \`
              -RestartInterval (New-TimeSpan -Minutes 1) -RestartCount 999 \`
              -ExecutionTimeLimit (New-TimeSpan -Hours 0)
Unregister-ScheduledTask -TaskName '${MITM_TASK_NAME}' -Confirm:$false -ErrorAction SilentlyContinue
Register-ScheduledTask -TaskName '${MITM_TASK_NAME}' -Action $action -Trigger $trigger -Settings $settings
Start-ScheduledTask -TaskName '${MITM_TASK_NAME}'
$state = (Get-ScheduledTask -TaskName '${MITM_TASK_NAME}' -ErrorAction SilentlyContinue).State
Write-Host "[myelin] mitmproxy task state: $state"
`);
}

export function mitmServiceStatus() {
  try {
    const out = execSync(`powershell -Command "(Get-ScheduledTask -TaskName '${MITM_TASK_NAME}' -ErrorAction SilentlyContinue).State"`, { stdio: 'pipe' }).toString().trim();
    return { running: out === 'Running', state: out };
  } catch {
    return { running: false, state: 'Unknown' };
  }
}

export function serviceStatus() {
  try {
    const out = execSync(`powershell -Command "(Get-ScheduledTask -TaskName '${TASK_NAME}' -ErrorAction SilentlyContinue).State"`, { stdio: 'pipe' }).toString().trim();
    return { running: out === 'Running', state: out };
  } catch {
    return { running: false, state: 'Unknown' };
  }
}
