import { execSync } from 'node:child_process';

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
  const ps = `
$headroomBin = "${opts.headroomBin.replace(/\//g, '\\\\')}";
$action = New-ScheduledTaskAction -Execute "$headroomBin.exe" -Argument "proxy --port ${opts.port}";
$trigger = New-ScheduledTaskTrigger -AtLogon -User $env:USERNAME;
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopOnIdleEnd -RestartInterval (New-TimeSpan -Minutes 1) -RestartCount 999 -ExecutionTimeLimit (New-TimeSpan -Hours 0);
Register-ScheduledTask -TaskName "TokenstackHeadroom" -Action $action -Trigger $trigger -Settings $settings -Force;
Start-ScheduledTask -TaskName "TokenstackHeadroom";
`;
  execSync(`powershell -ExecutionPolicy Bypass -Command "${ps.replace(/"/g, '\\"')}"`);
}

export function serviceStatus() {
  try {
    const out = execSync('powershell -Command "(Get-ScheduledTask -TaskName TokenstackHeadroom).State"').toString().trim();
    return { running: out === 'Running', state: out };
  } catch {
    return { running: false, state: 'Unknown' };
  }
}
