import { execSync } from 'node:child_process';

const TASK_NAME      = 'TokenstackHeadroom';
const MITM_TASK_NAME = 'MyelinMitmproxy';

export function generateTaskXml({ headroomBin, port }) {
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>TokenStack Headroom AI Proxy</Description>
    <URI>\\TokenstackHeadroom</URI>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger><Enabled>true</Enabled></LogonTrigger>
  </Triggers>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <RestartInterval>PT1M</RestartInterval>
    <RestartCount>999</RestartCount>
  </Settings>
  <Actions>
    <Exec>
      <Command>${headroomBin}</Command>
      <Arguments>proxy --port ${port}</Arguments>
    </Exec>
  </Actions>
</Task>`;
}

export function installService(opts) {
  const bin = opts.headroomBin.replace(/\//g, '\\');
  const ps = `
$bin = "${bin}";
$action = New-ScheduledTaskAction -Execute $bin -Argument "proxy --port ${opts.port}";
$trigger = New-ScheduledTaskTrigger -AtLogon -User $env:USERNAME;
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopOnIdleEnd -RestartInterval (New-TimeSpan -Minutes 1) -RestartCount 999 -ExecutionTimeLimit (New-TimeSpan -Hours 0);
Register-ScheduledTask -TaskName "${TASK_NAME}" -Action $action -Trigger $trigger -Settings $settings -Force;
Start-ScheduledTask -TaskName "${TASK_NAME}";
Start-Sleep -Seconds 3;
(Get-ScheduledTask -TaskName "${TASK_NAME}").State;
`;
  execSync(`powershell -ExecutionPolicy Bypass -Command "${ps.replace(/"/g, '\\"')}"`);
}

/**
 * Install mitmproxy as a Windows Scheduled Task (at-logon, restart on failure).
 * Uses mitmdump.exe — installed via `pip install mitmproxy` or winget/choco.
 */
export function installMitmService({ mitmdumpBin, port, addonPath, envVars = {} }) {
  const bin    = mitmdumpBin.replace(/\//g, '\\');
  const addon  = addonPath.replace(/\//g, '\\');
  const envStr = Object.entries(envVars)
    .map(([k, v]) => `[System.Environment]::SetEnvironmentVariable('${k}','${v}','User');`)
    .join(' ');
  const caBundle = (envVars.SSL_CERT_FILE || envVars.REQUESTS_CA_BUNDLE ||
                   envVars.NODE_EXTRA_CA_CERTS || '').replace(/\//g, '\\');
  const caArg = caBundle ? ` --set ssl_verify_upstream_trusted_ca=\\"${caBundle}\\"` : '';
  const proxyArg = (envVars.HTTPS_PROXY || '') ? ` --mode upstream:${envVars.HTTPS_PROXY}` : '';
  const ps = `
${envStr}
$action = New-ScheduledTaskAction -Execute "${bin}" -Argument "--listen-port ${port} -s \\"${addon}\\"${proxyArg}${caArg}";
$trigger = New-ScheduledTaskTrigger -AtLogon -User $env:USERNAME;
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopOnIdleEnd -RestartInterval (New-TimeSpan -Minutes 1) -RestartCount 999 -ExecutionTimeLimit (New-TimeSpan -Hours 0);
Register-ScheduledTask -TaskName "${MITM_TASK_NAME}" -Action $action -Trigger $trigger -Settings $settings -Force;
Start-ScheduledTask -TaskName "${MITM_TASK_NAME}";
`;
  execSync(`powershell -ExecutionPolicy Bypass -Command "${ps.replace(/"/g, '\\"')}"`);
}

export function mitmServiceStatus() {
  try {
    const out = execSync(`powershell -Command "(Get-ScheduledTask -TaskName ${MITM_TASK_NAME}).State"`).toString().trim();
    return { running: out === 'Running', state: out };
  } catch {
    return { running: false, state: 'Unknown' };
  }
}

export function serviceStatus() {
  try {
    const out = execSync(`powershell -Command "(Get-ScheduledTask -TaskName ${TASK_NAME}).State"`).toString().trim();
    return { running: out === 'Running', state: out };
  } catch {
    return { running: false, state: 'Unknown' };
  }
}
