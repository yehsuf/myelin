import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, mkdirSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generatePlist, generateGenericPlist } from '../src/service/launchd.mjs';
import { generateSystemdUnit, generateCopilotHeadroomUnit, generateMitmUnit } from '../src/service/systemd.mjs';
import {
  buildManagedHeadroomStopScript,
  HEADROOM_SERVICE_ID,
  collapseRedundantBackslashes,
  defaultWindowsHome,
  generateCopilotHeadroomRunScript,
  generateHeadroomRunScript,
  generateMitmRunScript,
  generateSetUserEnvVarsScript,
  generateWindowsWatchdogHealthcheckScript,
  generateWindowsWatchdogTaskCreateScript,
  generateWinswConfigXml,
  buildManagedMitmStatusScript,
  parseManagedMitmStatus,
  parseWinswServiceStatus,
  resolveWslWindowsHome,
  spawnDetachedService,
  stopManagedHeadroomProcess,
  winswConfigPath,
  winswExecutablePath,
} from '../src/service/windows.mjs';
import { resolveGlobalBinDir, linkGlobalBin } from '../src/service/npmlink.mjs';

const OPTS = {
  headroomBin: '/home/user/.local/bin/headroom',
  port: 8787,
  envVars: { ANTHROPIC_API_KEY: 'sk-test', HEADROOM_PORT: '8787' },
  logPath: '/tmp/headroom.log',
  user: 'testuser',
};

describe('launchd plist generator', () => {
  it('contains the label', () => {
    const xml = generatePlist(OPTS);
    assert.ok(xml.includes('com.myelin.headroom'));
  });
  it('contains the binary path', () => {
    const xml = generatePlist(OPTS);
    assert.ok(xml.includes(OPTS.headroomBin));
  });
  it('contains the port argument', () => {
    const xml = generatePlist(OPTS);
    assert.ok(xml.includes('8787'));
  });
  it('contains KeepAlive key', () => {
    const xml = generatePlist(OPTS);
    assert.ok(xml.includes('<key>KeepAlive</key>'));
  });
  it('contains env var', () => {
    const xml = generatePlist(OPTS);
    assert.ok(xml.includes('HEADROOM_PORT'));
  });
  it('omits --intercept-tool-results flag by default (uses env var instead)', () => {
    const xml = generatePlist(OPTS);
    assert.ok(!xml.includes('--intercept-tool-results'), 'flag not in plist args');
  });
  it('sets HEADROOM_INTERCEPT_ENABLED=1 env var when interceptToolResults=true', () => {
    const xml = generatePlist({ ...OPTS, interceptToolResults: true });
    assert.ok(xml.includes('HEADROOM_INTERCEPT_ENABLED'), 'env var present');
    assert.ok(xml.includes('1'), 'value is 1');
    assert.ok(!xml.includes('--intercept-tool-results'), 'flag not in args');
  });
});

describe('generateGenericPlist (mitmproxy / copilot-headroom launchd)', () => {
  const GENERIC_OPTS = {
    label: 'com.myelin.copilot-headroom',
    command: '/home/user/.venv/bin/headroom',
    args: ['proxy', '--port', '8788'],
    envVars: { ANTHROPIC_TARGET_API_URL: 'http://127.0.0.1:8889' },
    logPath: '/tmp/copilot-headroom.log',
  };
  it('omits WorkingDirectory key when not provided (backward compatible)', () => {
    const xml = generateGenericPlist(GENERIC_OPTS);
    assert.ok(!xml.includes('<key>WorkingDirectory</key>'));
  });
  it('adds WorkingDirectory key when provided (state isolation between instances)', () => {
    const xml = generateGenericPlist({ ...GENERIC_OPTS, workingDirectory: '/home/user/.myelin/copilot-headroom' });
    assert.ok(xml.includes('<key>WorkingDirectory</key>'));
    assert.ok(xml.includes('/home/user/.myelin/copilot-headroom'));
  });
  it('contains the label and args', () => {
    const xml = generateGenericPlist(GENERIC_OPTS);
    assert.ok(xml.includes('com.myelin.copilot-headroom'));
    assert.ok(xml.includes('--port'));
    assert.ok(xml.includes('8788'));
  });
});

describe('systemd unit generator', () => {
  it('contains ExecStart with binary', () => {
    const unit = generateSystemdUnit(OPTS);
    assert.ok(unit.includes('ExecStart=' + OPTS.headroomBin));
  });
  it('contains Restart=always', () => {
    const unit = generateSystemdUnit(OPTS);
    assert.ok(unit.includes('Restart=always'));
  });
  it('contains WantedBy=default.target', () => {
    const unit = generateSystemdUnit(OPTS);
    assert.ok(unit.includes('WantedBy=default.target'));
  });
  it('contains env var', () => {
    const unit = generateSystemdUnit(OPTS);
    assert.ok(unit.includes('HEADROOM_PORT'));
  });
  it('omits --intercept-tool-results flag (uses HEADROOM_INTERCEPT_ENABLED env var)', () => {
    const unit = generateSystemdUnit(OPTS);
    assert.ok(!unit.includes('--intercept-tool-results'), 'flag not in ExecStart');
  });
  it('sets HEADROOM_INTERCEPT_ENABLED=1 env var when interceptToolResults=true', () => {
    const unit = generateSystemdUnit({ ...OPTS, interceptToolResults: true });
    assert.ok(unit.includes('HEADROOM_INTERCEPT_ENABLED=1'), 'env var set');
    assert.ok(!unit.includes('--intercept-tool-results'), 'flag not in ExecStart');
  });
});

describe('systemd copilot-headroom unit generator', () => {
  const CH_OPTS = {
    headroomBin: OPTS.headroomBin,
    port: 8788,
    mode: 'cache',
    workingDirectory: '/home/user/.myelin/copilot-headroom',
    envVars: { ANTHROPIC_TARGET_API_URL: 'http://127.0.0.1:8889' },
  };
  it('contains WorkingDirectory pointing at the isolated state dir', () => {
    const unit = generateCopilotHeadroomUnit(CH_OPTS);
    assert.ok(unit.includes('WorkingDirectory=/home/user/.myelin/copilot-headroom'));
  });
  it('contains the port and mode in ExecStart', () => {
    const unit = generateCopilotHeadroomUnit(CH_OPTS);
    assert.ok(unit.includes('--port 8788'));
    assert.ok(unit.includes('--mode cache'));
  });
  it('has a distinct description from the Claude-Headroom unit', () => {
    const unit = generateCopilotHeadroomUnit(CH_OPTS);
    assert.ok(unit.includes('Copilot-Headroom'));
  });
});

describe('systemd mitm unit generator — egress dual-listener', () => {
  it('supports ingress plus loopback-bound egress listener args', () => {
    const args = ['--mode', 'regular@8888', '--mode', 'regular@127.0.0.1:8889', '-s', '/path/addon.py'];
    const unit = generateMitmUnit({ mitmdumpBin: '/usr/bin/mitmdump', args });
    assert.ok(unit.includes('regular@8888'));
    assert.ok(unit.includes('regular@127.0.0.1:8889'));
  });
});

describe('windows run-script generator', () => {
  it('buildManagedHeadroomStopScript only targets Myelin-managed headroom proxy processes', () => {
    const script = buildManagedHeadroomStopScript({ port: 8787 });
    assert.ok(script.includes(`$pidPath =`));
    assert.ok(script.includes(`Get-Content -Path $pidPath`));
    assert.ok(script.includes(`ProcessId = $managedPid`));
    assert.ok(script.includes('ParentProcessId'));
    assert.ok(script.includes('start-headroom\\.ps1'));
    assert.ok(script.includes('proxy'));
    assert.ok(script.includes(`--port\\s+8787(\\s|$)`));
    assert.ok(!script.includes('Get-NetTCPConnection'));
    assert.ok(!script.includes('OwningProcess'));
  });

  it('contains registry run key name', () => {
    const script = generateHeadroomRunScript(OPTS);
    assert.ok(script.includes('MyelinHeadroom'));
  });
  it('contains command path', () => {
    const script = generateHeadroomRunScript(OPTS);
    assert.ok(script.includes(OPTS.headroomBin.replace(/\//g, '\\')));
  });
  it('contains port argument', () => {
    const script = generateHeadroomRunScript(OPTS);
    assert.ok(script.includes('8787'));
  });
  it('omits --intercept-tool-results flag (uses HEADROOM_INTERCEPT_ENABLED env var)', () => {
    const script = generateHeadroomRunScript(OPTS);
    assert.ok(!script.includes('--intercept-tool-results'), 'flag not in script');
  });
  it('sets HEADROOM_INTERCEPT_ENABLED=1 env var when interceptToolResults passed via envVars', () => {
    const script = generateHeadroomRunScript({ ...OPTS, envVars: { HEADROOM_INTERCEPT_ENABLED: '1' } });
    assert.ok(script.includes('HEADROOM_INTERCEPT_ENABLED'), 'env var in script');
    assert.ok(!script.includes('--intercept-tool-results'), 'flag not in script');
  });
  it('stops only the process matching this exact port (not all headroom.exe instances)', () => {
    const script = generateHeadroomRunScript(OPTS);
    assert.ok(script.includes(`--port ${OPTS.port}`));
    assert.ok(script.includes('Win32_Process'));
    assert.ok(!script.includes('Stop-Process -Name headroom '));
  });
  it('injects envVars as $env: assignments before Start-Process', () => {
    const script = generateHeadroomRunScript({
      ...OPTS,
      envVars: { OPENAI_TARGET_API_URL: 'https://api.githubcopilot.com', HEADROOM_MODE: 'cache' },
    });
    assert.ok(script.includes("$env:OPENAI_TARGET_API_URL = 'https://api.githubcopilot.com'"), 'OPENAI_TARGET_API_URL set');
    assert.ok(script.includes("$env:HEADROOM_MODE = 'cache'"), 'HEADROOM_MODE set');
    // env block must appear BEFORE Start-Process
    const envIdx  = script.indexOf('$env:OPENAI_TARGET_API_URL');
    const startIdx = script.indexOf('Start-Process');
    assert.ok(envIdx < startIdx, 'env block before Start-Process');
  });
  it('skips empty envVars values', () => {
    const script = generateHeadroomRunScript({ ...OPTS, envVars: { EMPTY_VAR: '', REAL_VAR: 'value' } });
    assert.ok(!script.includes('$env:EMPTY_VAR'), 'empty value not emitted');
    assert.ok(script.includes("$env:REAL_VAR = 'value'"), 'non-empty value emitted');
  });
  it('escapes single quotes in envVar values', () => {
    const script = generateHeadroomRunScript({ ...OPTS, envVars: { MY_VAR: "it's here" } });
    assert.ok(script.includes("$env:MY_VAR = 'it''s here'"), 'single quote escaped');
  });

  it('falls back to the legacy Myelin run-key command when the managed pid file is absent', () => {
    let command = '';
    stopManagedHeadroomProcess({
      port: 8787,
      execSyncImpl: (value) => {
        command = value;
        return Buffer.from('');
      },
      headroomRunKeyStatusImpl: () => ({
        registered: true,
        raw: '"C:\\Users\\alice\\.myelin\\bin\\headroom.exe" proxy --port 8787',
      }),
    });
    assert.ok(command.includes('ProcessId = $managedPid'));
    assert.ok(command.includes(`ExecutablePath -eq 'C:\\Users\\alice\\.myelin\\bin\\headroom.exe'`));
    assert.ok(command.includes(`Name = 'headroom.exe'`));
    assert.ok(command.includes(`--port\\s+8787(\\s|$)`));
  });
});

describe('WinSW XML generator', () => {
  const WINSW_OPTS = {
    id: 'myelin-headroom',
    name: 'Myelin Headroom',
    description: 'Myelin token-efficiency proxy (Headroom)',
    executable: 'C:\\Users\\alice\\.myelin\\venv\\Scripts\\headroom.exe',
    arguments: 'proxy --port 8787',
    logPath: 'C:\\Users\\alice\\.myelin\\logs',
    envVars: { HEADROOM_PORT: '8787', OPENAI_TARGET_API_URL: 'https://api.githubcopilot.com' },
    onFailureDelays: ['5 sec', '30 sec'],
  };

  it('contains the service id, executable, and arguments', () => {
    const xml = generateWinswConfigXml(WINSW_OPTS);
    assert.ok(xml.includes('<id>myelin-headroom</id>'));
    assert.ok(xml.includes(WINSW_OPTS.executable));
    assert.ok(xml.includes(WINSW_OPTS.arguments));
  });

  it('emits env vars plus restart-on-failure policy', () => {
    const xml = generateWinswConfigXml(WINSW_OPTS);
    assert.ok(xml.includes('<env name="HEADROOM_PORT" value="8787"/>'));
    assert.ok(xml.includes('<env name="OPENAI_TARGET_API_URL" value="https://api.githubcopilot.com"/>'));
    assert.ok(xml.includes('<onfailure action="restart" delay="5 sec"/>'));
    assert.ok(xml.includes('<onfailure action="restart" delay="30 sec"/>'));
    assert.ok(xml.includes('<resetfailure>1 hour</resetfailure>'));
    assert.ok(xml.includes('<hidewindow>true</hidewindow>'));
  });

  it('XML-escapes reserved characters', () => {
    const xml = generateWinswConfigXml({
      ...WINSW_OPTS,
      description: 'Proxy <watchdog> & "health"',
      envVars: { SPECIAL: `A&B<"'` },
    });
    assert.ok(xml.includes('Proxy &lt;watchdog&gt; &amp; &quot;health&quot;'));
    assert.ok(xml.includes('value="A&amp;B&lt;&quot;&apos;"'));
  });
});

describe('WinSW status parser', () => {
  it('treats Active (running) as running', () => {
    assert.deepEqual(parseWinswServiceStatus('Active (running)'), {
      running: true,
      state: 'Active (running)',
      raw: 'Active (running)',
    });
  });

  it('treats Inactive (stopped) as not running', () => {
    assert.deepEqual(parseWinswServiceStatus('Inactive (stopped)'), {
      running: false,
      state: 'Inactive (stopped)',
      raw: 'Inactive (stopped)',
    });
  });

  it('treats NonExistent as not running', () => {
    assert.deepEqual(parseWinswServiceStatus('NonExistent'), {
      running: false,
      state: 'NonExistent',
      raw: 'NonExistent',
    });
  });
});

describe('resolveWslWindowsHome', () => {
  const dir = (name) => ({ name, isDirectory: () => true });

  it('returns a cleaned USERPROFILE value from PowerShell output', () => {
    const home = resolveWslWindowsHome({
      execSync: () => Buffer.from('\uFEFFC:\\Users\\alice\r\nignored\r\n'),
      existsSync: () => false,
      readdirSync: () => [],
    });
    assert.equal(home, 'C:\\Users\\alice');
  });

  it('falls through from User scope to Machine scope', () => {
    const calls = [];
    const home = resolveWslWindowsHome({
      execSync: (command) => {
        calls.push(command);
        if (command.includes("'User')")) return Buffer.from('\r\n');
        return Buffer.from('C:\\Users\\machine\r\n');
      },
      existsSync: () => false,
      readdirSync: () => [],
    });
    assert.equal(home, 'C:\\Users\\machine');
    assert.equal(calls.length, 2);
  });

  it('falls back to a single non-system profile under /mnt/c/Users', () => {
    const home = resolveWslWindowsHome({
      execSync: () => { throw new Error('interop disabled'); },
      existsSync: (path) => path === '/mnt/c/Users',
      readdirSync: () => [
        dir('Public'),
        dir('Default'),
        dir('alice'),
      ],
    });
    assert.equal(home, '/mnt/c/Users/alice');
  });

  it('returns null when the filesystem scan is empty or ambiguous', () => {
    assert.equal(resolveWslWindowsHome({
      execSync: () => { throw new Error('interop disabled'); },
      existsSync: (path) => path === '/mnt/c/Users',
      readdirSync: () => [dir('Public'), dir('Default')],
    }), null);
    assert.equal(resolveWslWindowsHome({
      execSync: () => { throw new Error('interop disabled'); },
      existsSync: (path) => path === '/mnt/c/Users',
      readdirSync: () => [dir('alice'), dir('bob')],
    }), null);
  });
});

describe('defaultWindowsHome', () => {
  it('preserves the previous non-WSL fallback behavior when WSL is not detected', () => {
    const savedUserProfile = process.env.USERPROFILE;
    delete process.env.USERPROFILE;
    try {
      assert.equal(defaultWindowsHome(undefined, {
        isWslImpl: () => false,
        resolveWslWindowsHomeImpl: () => { throw new Error('should not be called'); },
        homedirImpl: () => '/home/alice',
      }), '\\home\\alice');
      assert.equal(defaultWindowsHome('C:/Users/alice', {
        isWslImpl: () => false,
      }), 'C:\\Users\\alice');
    } finally {
      if (savedUserProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = savedUserProfile;
    }
  });

  it('converts a mounted WSL home path into a Windows home path', () => {
    const savedUserProfile = process.env.USERPROFILE;
    delete process.env.USERPROFILE;
    try {
      assert.equal(defaultWindowsHome(undefined, {
        isWslImpl: () => true,
        resolveWslWindowsHomeImpl: () => '/mnt/c/Users/alice',
        homedirImpl: () => '/home/alice',
      }), 'C:\\Users\\alice');
    } finally {
      if (savedUserProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = savedUserProfile;
    }
  });

  it('prefers the resolved Windows home over an explicit POSIX WSL home path', () => {
    const savedUserProfile = process.env.USERPROFILE;
    delete process.env.USERPROFILE;
    try {
      assert.equal(defaultWindowsHome('/home/alice', {
        isWslImpl: () => true,
        resolveWslWindowsHomeImpl: () => 'C:/Users/alice',
        homedirImpl: () => '/home/alice',
      }), 'C:\\Users\\alice');
    } finally {
      if (savedUserProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = savedUserProfile;
    }
  });
});

describe('Windows watchdog generators', () => {
  const home = 'C:\\Users\\alice';
  const configPath = winswConfigPath({ id: HEADROOM_SERVICE_ID, home });
  const exePath = winswExecutablePath({ id: HEADROOM_SERVICE_ID, home });
  const logPath = 'C:\\Users\\alice\\.myelin\\services\\myelin-headroom\\watchdog.log';

  it('builds a healthcheck script that probes /health and restarts via WinSW', () => {
    const script = generateWindowsWatchdogHealthcheckScript({
      serviceName: 'Myelin Headroom',
      healthUrl: 'http://127.0.0.1:8787/health',
      winswExePath: exePath,
      winswConfigPath: configPath,
      logPath,
    });
    assert.ok(script.includes('Invoke-WebRequest'));
    assert.ok(script.includes('http://127.0.0.1:8787/health'));
    assert.ok(script.includes('& $WinswExe restart $WinswConfig'));
    assert.ok(script.includes('& $WinswExe stop $WinswConfig --force --no-wait'));
    assert.ok(script.includes('& $WinswExe start $WinswConfig'));
    assert.ok(script.includes(exePath));
    assert.ok(script.includes(configPath));
  });

  it('builds a Scheduled Task creation script with minute cadence', () => {
    const script = generateWindowsWatchdogTaskCreateScript({
      taskName: 'Myelin Headroom Watchdog',
      scriptPath: 'C:\\Users\\alice\\.myelin\\services\\myelin-headroom\\watchdog.ps1',
      intervalMinutes: 2,
    });
    assert.ok(script.includes('schtasks.exe /create'));
    assert.ok(script.includes('/sc minute /mo 2'));
    assert.ok(script.includes('Myelin Headroom Watchdog'));
    assert.ok(script.includes('powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File'));
    assert.ok(script.includes('/ru System /rl HIGHEST /f'));
  });

  it('rejects invalid Scheduled Task intervals', () => {
    assert.throws(() => generateWindowsWatchdogTaskCreateScript({
      taskName: 'Myelin Headroom Watchdog',
      scriptPath: 'C:\\watchdog.ps1',
      intervalMinutes: 0,
    }), /intervalMinutes/);
  });
});

describe('windows copilot-headroom run-script generator', () => {
  const CH_OPTS = {
    headroomBin: OPTS.headroomBin,
    port: 8788,
    mode: 'cache',
    workingDirectory: 'C:\\Users\\yehsuf\\.myelin\\copilot-headroom',
    envVars: { ANTHROPIC_TARGET_API_URL: 'http://127.0.0.1:8889' },
  };
  it('contains a distinct registry run key name from the Claude-Headroom instance', () => {
    const script = generateCopilotHeadroomRunScript(CH_OPTS);
    assert.ok(script.includes('MyelinCopilotHeadroom'));
  });
  it('sets -WorkingDirectory for state isolation', () => {
    const script = generateCopilotHeadroomRunScript(CH_OPTS);
    assert.ok(script.includes('-WorkingDirectory'));
    assert.ok(script.includes('copilot-headroom'));
  });
  it('contains the port and mode', () => {
    const script = generateCopilotHeadroomRunScript(CH_OPTS);
    assert.ok(script.includes('--port 8788'));
    assert.ok(script.includes('--mode cache'));
  });
  it('stops only the process on this exact port', () => {
    const script = generateCopilotHeadroomRunScript(CH_OPTS);
    assert.ok(script.includes('Win32_Process'));
  });
  it('persists a Run-key launcher that preserves scoped target env vars after login', () => {
    const script = generateCopilotHeadroomRunScript({
      ...CH_OPTS,
      envVars: {
        ANTHROPIC_TARGET_API_URL: 'http://127.0.0.1:8889',
        OPENAI_TARGET_API_URL: 'http://127.0.0.1:8889',
      },
    });
    assert.ok(script.includes('start-copilot-headroom.ps1'));
    assert.ok(script.includes('Set-ItemProperty'));
    assert.ok(script.includes('powershell.exe -NoProfile -ExecutionPolicy Bypass -File'));
    assert.ok(script.includes("[System.Environment]::SetEnvironmentVariable('ANTHROPIC_TARGET_API_URL', 'http://127.0.0.1:8889', 'Process')"));
    assert.ok(script.includes("[System.Environment]::SetEnvironmentVariable('OPENAI_TARGET_API_URL', 'http://127.0.0.1:8889', 'Process')"));
  });
});

describe('windows mitm run-script generator — egress dual-listener', () => {
  const MITM_OPTS = {
    mitmdumpBin: '/usr/bin/mitmdump',
    port: 8888,
    addonPath: '/path/addon.py',
    envVars: {},
    home: 'C:\\Users\\alice',
  };
  it('uses --listen-port when no egressPort is given (backward compatible)', () => {
    const script = generateMitmRunScript(MITM_OPTS);
    assert.ok(script.includes('--listen-port 8888'));
    assert.ok(!script.includes('regular@'));
  });
  it('uses ingress plus loopback-bound egress --mode args when egressPort is given', () => {
    const script = generateMitmRunScript({ ...MITM_OPTS, egressPort: 8889 });
    assert.ok(script.includes('--mode regular@8888'));
    assert.ok(script.includes('--mode regular@127.0.0.1:8889'));
    assert.ok(!script.includes('--listen-port'));
  });
  it('sets MYELIN_EGRESS_PORT when egressPort is given', () => {
    const script = generateMitmRunScript({ ...MITM_OPTS, egressPort: 8889 });
    assert.ok(script.includes('MYELIN_EGRESS_PORT'));
  });

  it('sets rebuilt managed env vars in Process scope before launching mitmdump', () => {
    const script = generateMitmRunScript({
      ...MITM_OPTS,
      egressPort: 8889,
      envVars: {
        MYELIN_HEADROOM_PORT: '8790',
        MYELIN_COPILOT_HEADROOM_PORT: '8788',
        MYELIN_BLOCK_BYPASS: '1',
      },
    });

    const headroomIdx = script.indexOf("SetEnvironmentVariable('MYELIN_HEADROOM_PORT', '8790', 'Process')");
    const copilotIdx = script.indexOf("SetEnvironmentVariable('MYELIN_COPILOT_HEADROOM_PORT', '8788', 'Process')");
    const bypassIdx = script.indexOf("SetEnvironmentVariable('MYELIN_BLOCK_BYPASS', '1', 'Process')");
    const startIdx = script.lastIndexOf('-WindowStyle Hidden -PassThru');

    assert.ok(headroomIdx >= 0);
    assert.ok(copilotIdx >= 0);
    assert.ok(bypassIdx >= 0);
    assert.ok(startIdx > bypassIdx);
    assert.ok(script.includes('start-mitmproxy.ps1'));
    assert.ok(script.includes("New-Item -ItemType Directory -Force -Path 'C:\\Users\\alice\\.myelin\\services\\myelin-mitmproxy'"));
  });

  it('clears stale optional managed env vars and avoids killing unrelated mitmdump processes', () => {
    const script = generateMitmRunScript({
      ...MITM_OPTS,
      envVars: { MYELIN_HEADROOM_PORT: '8787' },
    });

    assert.ok(script.includes("SetEnvironmentVariable('MYELIN_COPILOT_HEADROOM_PORT', $null, 'Process')"));
    assert.ok(script.includes("SetEnvironmentVariable('MYELIN_EGRESS_PORT', $null, 'Process')"));
    assert.ok(script.includes("SetEnvironmentVariable('MYELIN_BLOCK_BYPASS', $null, 'Process')"));
    assert.ok(script.includes('mitm.pid'));
    assert.ok(script.includes('ProcessId = $managedPid'));
    assert.ok(script.includes('ParentProcessId'));
    assert.ok(script.includes('start-mitmproxy\\.ps1'));
    assert.ok(!script.includes('Stop-Process -Name mitmdump'));
  });

  // Regression test for a live bug: a real Windows path (e.g. a NetFree
  // corporate CA file) got written into the managed launcher with every
  // backslash doubled, and the doubled value got read back as input on the
  // next `myelin restart`, silently compounding across runs - observed live as
  // C:\\\\\\\\ProgramData\\\\\\\\NetFree\\\\\\\\CA\\\\\\\\netfree-ca-list.crt
  // (8 backslashes per separator) after 3 restarts.
  it('does not double backslashes in a managed launcher env var value (regression)', () => {
    const script = generateMitmRunScript({
      ...MITM_OPTS,
      envVars: { NODE_EXTRA_CA_CERTS: 'C:\\Users\\yehsuf\\.myelin\\ca-bundle.pem' },
    });
    assert.ok(script.includes("SetEnvironmentVariable('NODE_EXTRA_CA_CERTS', 'C:\\Users\\yehsuf\\.myelin\\ca-bundle.pem', 'Process')"));
    assert.ok(!script.includes("SetEnvironmentVariable('NODE_EXTRA_CA_CERTS', 'C:\\\\Users"));
  });

  it('self-heals an already-doubled value instead of doubling it further', () => {
    const script = generateMitmRunScript({
      ...MITM_OPTS,
      envVars: { NODE_EXTRA_CA_CERTS: 'C:\\\\ProgramData\\\\NetFree\\\\CA\\\\netfree-ca-list.crt' },
    });
    assert.ok(script.includes("SetEnvironmentVariable('NODE_EXTRA_CA_CERTS', 'C:\\ProgramData\\NetFree\\CA\\netfree-ca-list.crt', 'Process')"));
  });

  it('self-heals a severely compounded value (the exact 8-backslash case observed live)', () => {
    const corrupted = 'C:' + '\\\\\\\\ProgramData' + '\\\\\\\\NetFree' + '\\\\\\\\CA' + '\\\\\\\\netfree-ca-list.crt';
    const script = generateMitmRunScript({ ...MITM_OPTS, envVars: { NODE_EXTRA_CA_CERTS: corrupted } });
    assert.ok(script.includes("SetEnvironmentVariable('NODE_EXTRA_CA_CERTS', 'C:\\ProgramData\\NetFree\\CA\\netfree-ca-list.crt', 'Process')"));
  });

  it('still escapes a literal single-quote in the value', () => {
    const script = generateMitmRunScript({ ...MITM_OPTS, envVars: { SOME_VAR: "it's a path" } });
    assert.ok(script.includes("SetEnvironmentVariable('SOME_VAR', 'it''s a path', 'Process')"));
  });

  it('builds registry status checks that only accept the managed PID, launcher, and exact command line', () => {
    const script = buildManagedMitmStatusScript({
      pid: 4321,
      executablePath: 'C:\\Users\\alice\\.myelin\\venv\\Scripts\\mitmdump.exe',
      argStr: '--listen-port 8888 -s "C:\\Users\\alice\\.myelin\\services\\myelin-mitmproxy\\addon.py"',
      launcherPath: 'C:\\Users\\alice\\.myelin\\services\\myelin-mitmproxy\\start-mitmproxy.ps1',
    });

    assert.ok(script.includes('$managedPid = 4321'));
    assert.ok(script.includes(`ProcessId = $managedPid`));
    assert.ok(script.includes(`ExecutablePath -eq 'C:\\Users\\alice\\.myelin\\venv\\Scripts\\mitmdump.exe'`));
    assert.ok(script.includes(`CommandLine -match '--listen-port 8888 -s "C:\\\\Users\\\\alice\\\\\\.myelin\\\\services\\\\myelin-mitmproxy\\\\addon\\.py"$'`));
    assert.ok(script.includes(`start-mitmproxy\\.ps1`));
  });
});

describe('Managed mitm status parser', () => {
  it('only reports Running for the managed probe output', () => {
    assert.deepEqual(parseManagedMitmStatus('Running'), {
      running: true,
      state: 'Running',
      raw: 'Running',
    });
    assert.deepEqual(parseManagedMitmStatus('mitmdump.exe'), {
      running: false,
      state: 'mitmdump.exe',
      raw: 'mitmdump.exe',
    });
    assert.deepEqual(parseManagedMitmStatus(''), {
      running: false,
      state: 'Unknown',
      raw: '',
    });
  });
});

describe('collapseRedundantBackslashes', () => {
  it('leaves a normal single-backslash Windows path untouched', () => {
    assert.equal(collapseRedundantBackslashes('C:\\Users\\yehsuf\\.myelin\\ca-bundle.pem'), 'C:\\Users\\yehsuf\\.myelin\\ca-bundle.pem');
  });

  it('collapses a doubled path down to single backslashes', () => {
    assert.equal(collapseRedundantBackslashes('C:\\\\ProgramData\\\\NetFree'), 'C:\\ProgramData\\NetFree');
  });

  it('collapses a quadrupled/octupled path down to single backslashes', () => {
    assert.equal(collapseRedundantBackslashes('C:\\\\\\\\ProgramData\\\\\\\\NetFree'), 'C:\\ProgramData\\NetFree');
  });

  it('preserves a genuine UNC path prefix (\\\\server\\share) instead of collapsing it to one backslash', () => {
    assert.equal(collapseRedundantBackslashes('\\\\server\\share\\file.pem'), '\\\\server\\share\\file.pem');
  });

  it('still collapses corruption elsewhere in a UNC path while preserving its prefix', () => {
    assert.equal(collapseRedundantBackslashes('\\\\server\\\\share\\\\file.pem'), '\\\\server\\share\\file.pem');
  });

  it('handles empty/null/undefined without throwing', () => {
    assert.equal(collapseRedundantBackslashes(''), '');
    assert.equal(collapseRedundantBackslashes(null), '');
    assert.equal(collapseRedundantBackslashes(undefined), '');
  });

  it('is idempotent - collapsing an already-clean value is a no-op', () => {
    const once = collapseRedundantBackslashes('C:\\\\\\\\Program');
    assert.equal(collapseRedundantBackslashes(once), once);
  });
});

describe('windows registry env var script generator', () => {
  it('sets each var via [Environment]::SetEnvironmentVariable with User scope', () => {
    const script = generateSetUserEnvVarsScript({ HEADROOM_PORT: '8787' });
    assert.ok(script.includes("[Environment]::SetEnvironmentVariable('HEADROOM_PORT', '8787', 'User')"));
  });
  it('does not double backslashes (single-quoted PS strings need none)', () => {
    const script = generateSetUserEnvVarsScript({ SSL_CERT_FILE: 'C:\\Users\\yehsuf\\ca-bundle.pem' });
    assert.ok(script.includes("'C:\\Users\\yehsuf\\ca-bundle.pem'"));
    assert.ok(!script.includes('\\\\'));
  });
  it('doubles a literal single-quote in a value', () => {
    const script = generateSetUserEnvVarsScript({ WEIRD: "it's a test" });
    assert.ok(script.includes("'it''s a test'"));
  });
  it('handles multiple vars, one line each', () => {
    const script = generateSetUserEnvVarsScript({ A: '1', B: '2' });
    assert.equal(script.trim().split('\n').length, 2);
  });
  it('self-heals an already-doubled value instead of leaving it corrupted', () => {
    const script = generateSetUserEnvVarsScript({ SSL_CERT_FILE: 'C:\\\\ProgramData\\\\NetFree\\\\netfree-ca-list.crt' });
    assert.ok(script.includes("'C:\\ProgramData\\NetFree\\netfree-ca-list.crt'"));
  });
});

describe('npm global bin dir resolver', () => {
  it('appends bin/ on posix', () => {
    assert.equal(resolveGlobalBinDir('/usr/local', 'darwin'), '/usr/local/bin');
    assert.equal(resolveGlobalBinDir('/usr/local', 'linux'), '/usr/local/bin');
  });
  it('uses the prefix directly on windows (no bin/ subfolder)', () => {
    assert.equal(resolveGlobalBinDir('C:\\nvm4w\\nodejs', 'windows'), 'C:\\nvm4w\\nodejs');
  });
});

describe('linkGlobalBin', () => {
  it('gracefully reports failure (not throwing) for a non-writable prefix', { skip: process.platform === 'win32' }, () => {
    const roDir = mkdtempSync(join(tmpdir(), 'myelin-ro-'));
    const binDir = join(roDir, 'bin');
    mkdirSync(binDir);
    chmodSync(binDir, 0o555);
    try {
      const result = linkGlobalBin({ repoRoot: process.cwd(), os: 'darwin', prefix: roDir });
      assert.equal(result.linked, false);
      assert.ok(result.reason.includes('no write access'));
    } finally {
      chmodSync(binDir, 0o755);
      rmSync(roDir, { recursive: true, force: true });
    }
  });
});

describe('spawnDetachedService', () => {
  it('passes exe and argStr to the PS script (Task Scheduler path)', () => {
    const scripts = [];
    spawnDetachedService('MyelinHeadroom', 'C:\\bin\\headroom.exe', 'proxy --port 8787', {
      runPsFn: (s) => scripts.push(s),
    });
    assert.equal(scripts.length, 1);
    const s = scripts[0];
    assert.ok(s.includes('MyelinHeadroom'), 'task name present');
    assert.ok(s.includes('headroom.exe'), 'exe present');
    assert.ok(s.includes('proxy --port 8787'), 'args present');
    assert.ok(s.includes('Register-ScheduledTask'), 'uses task scheduler');
    assert.ok(s.includes('Start-ScheduledTask'), 'starts the task');
  });

  it('sanitises task name — strips non-alphanumeric chars', () => {
    const scripts = [];
    spawnDetachedService('Myelin Headroom!', 'exe.exe', 'arg', { runPsFn: (s) => scripts.push(s) });
    assert.ok(scripts[0].includes('Myelin_Headroom_'), 'spaces/special chars replaced with _');
  });

  it('escapes single quotes in exe path', () => {
    const scripts = [];
    spawnDetachedService('T', "C:\\it's\\exe.exe", 'args', { runPsFn: (s) => scripts.push(s) });
    assert.ok(scripts[0].includes("it''s"), 'single quotes doubled');
  });

  it('includes fallback Start-Process block', () => {
    const scripts = [];
    spawnDetachedService('T', 'exe.exe', 'args', { runPsFn: (s) => scripts.push(s) });
    assert.ok(scripts[0].includes('Start-Process'), 'fallback present');
    assert.ok(scripts[0].includes('SSL_CERT_FILE'), 'loads SSL env vars in fallback');
  });

  it('does not path-normalize URL-valued task env vars', () => {
    const scripts = [];
    spawnDetachedService('T', 'exe.exe', 'args', {
      runPsFn: (s) => scripts.push(s),
      taskEnv: {
        HEADROOM_WORKSPACE_DIR: 'C:/Users/alice/.myelin/copilot',
        ANTHROPIC_TARGET_API_URL: 'http://127.0.0.1:8889',
      },
    });
    assert.ok(scripts[0].includes('set "HEADROOM_WORKSPACE_DIR=C:\\Users\\alice\\.myelin\\copilot"'));
    assert.ok(scripts[0].includes('set "ANTHROPIC_TARGET_API_URL=http://127.0.0.1:8889"'));
    assert.ok(!scripts[0].includes('http:\\\\127.0.0.1:8889'));
  });
});
