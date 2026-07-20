import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { join } from 'node:path';
import {
  installTokenOptimizerForCopilot,
  tokenOptimizerClaudeCodeInstructions,
  tokenOptimizerCopilotInstallSteps,
  tokenOptimizerLicenseNotice,
  tokenOptimizerWindowsManualInstructions,
  defaultWslCloneDir,
  defaultCloneDir,
} from '../src/service/token-optimizer.mjs';

function captureConsole() {
  const events = [];
  return {
    events,
    log(message = '') {
      events.push({ type: 'log', message });
    },
    warn(message = '') {
      events.push({ type: 'warn', message });
    },
  };
}

function makeExecStub({ failOn = null } = {}) {
  const calls = [];
  return {
    calls,
    exec(command, options = {}) {
      calls.push({ command, options });
      if (failOn && command.includes(failOn)) throw new Error(`${failOn} failed hard`);
      return Buffer.from('');
    },
  };
}

function makeExecFileStub({ failOn = null } = {}) {
  const calls = [];
  return {
    calls,
    execFile(file, args = [], options = {}) {
      calls.push({ file, args, options });
      const joined = `${file} ${args.join(' ')}`;
      if (failOn && joined.includes(failOn)) throw new Error(`${failOn} failed hard`);
      return Buffer.from('');
    },
  };
}

describe('tokenOptimizerLicenseNotice', () => {
  it('mentions PolyForm Noncommercial and the repo URL', () => {
    const notice = tokenOptimizerLicenseNotice();
    assert.match(notice, /PolyForm Noncommercial/i);
    assert.match(notice, /https:\/\/github\.com\/alexgreensh\/token-optimizer/);
  });
});

describe('tokenOptimizerClaudeCodeInstructions', () => {
  it('includes the verified slash commands', () => {
    const text = tokenOptimizerClaudeCodeInstructions();
    assert.match(text, /\/plugin marketplace add alexgreensh\/token-optimizer/);
    assert.match(text, /\/plugin install token-optimizer@alexgreensh-token-optimizer/);
    assert.match(text, /\/token-optimizer/);
  });
});

describe('defaultCloneDir — threads os/platform into the managed root', () => {
  it('keeps a Windows default root backslashed when os is windows, on any host', () => {
    assert.equal(
      defaultCloneDir({ os: 'windows', env: {}, home: 'C:\\Users\\alice' }),
      'C:\\Users\\alice\\.myelin\\token-optimizer',
    );
  });

  it('keeps a POSIX default root forward-slashed when os is darwin/linux, on any host', () => {
    assert.equal(
      defaultCloneDir({ os: 'darwin', env: {}, home: '/Users/alice' }),
      '/Users/alice/.myelin/token-optimizer',
    );
  });
});

describe('tokenOptimizerCopilotInstallSteps', () => {
  const cloneDir = '/Users/alice/.myelin/token-optimizer';

  it('returns an argv git checkout + fixed-literal install commands (darwin)', () => {
    const plan = tokenOptimizerCopilotInstallSteps({ os: 'darwin', cloneDir });
    assert.equal(plan.automatable, true);
    assert.equal(plan.cloneDir, cloneDir);
    assert.deepEqual(plan.checkout, {
      file: 'git',
      args: ['clone', '--depth', '1', 'https://github.com/alexgreensh/token-optimizer.git', cloneDir],
    });
    assert.deepEqual(plan.commands, [
      'bash install.sh --copilot',
      'TOKEN_OPTIMIZER_RUNTIME=copilot python3 skills/token-optimizer/scripts/measure.py copilot-doctor',
    ]);
    assert.deepEqual(plan.manualInstructions, []);
    // The managed cloneDir never lands inside a shell command string.
    assert.ok(plan.commands.every((c) => !c.includes(cloneDir)), JSON.stringify(plan.commands));
  });

  it('returns automatable linux steps with an argv checkout ending in cloneDir', () => {
    const plan = tokenOptimizerCopilotInstallSteps({ os: 'linux', cloneDir });
    assert.equal(plan.automatable, true);
    assert.equal(plan.checkout.file, 'git');
    assert.equal(plan.checkout.args.at(-1), cloneDir);
    assert.equal(plan.commands[0], 'bash install.sh --copilot');
  });

  it('returns automatable win32 steps with py -3 native install commands', () => {
    const plan = tokenOptimizerCopilotInstallSteps({
      os: 'win32',
      cloneDir: 'C:\\Users\\alice\\.myelin\\token-optimizer',
      existsSync: () => false,
    });
    assert.equal(plan.automatable, true);
    assert.deepEqual(plan.checkout, {
      file: 'git',
      args: ['clone', '--depth', '1', 'https://github.com/alexgreensh/token-optimizer.git', 'C:\\Users\\alice\\.myelin\\token-optimizer'],
    });
    assert.deepEqual(plan.commands, [
      'set "TOKEN_OPTIMIZER_RUNTIME=copilot" && py -3 skills/token-optimizer/scripts/measure.py copilot-install',
      'set "TOKEN_OPTIMIZER_RUNTIME=copilot" && py -3 skills/token-optimizer/scripts/measure.py copilot-doctor',
    ]);
    assert.deepEqual(plan.manualInstructions, []);
  });

  it('omits the copilot-doctor command when skipDoctor is true', () => {
    const plan = tokenOptimizerCopilotInstallSteps({ os: 'darwin', cloneDir, skipDoctor: true });
    assert.ok(!plan.commands.some(c => c.includes('copilot-doctor')), 'copilot-doctor must be absent');
    assert.equal(plan.commands.length, 1, 'only install command should remain');
    assert.ok(plan.commands[0].includes('install'), 'install command must be present');
  });

  it('includes the copilot-doctor command by default (skipDoctor=false)', () => {
    const plan = tokenOptimizerCopilotInstallSteps({ os: 'darwin', cloneDir, skipDoctor: false });
    assert.ok(plan.commands.some(c => c.includes('copilot-doctor')), 'copilot-doctor must be present');
  });

  it('omits copilot-doctor on Windows when skipDoctor=true', () => {
    const plan = tokenOptimizerCopilotInstallSteps({
      os: 'win32', cloneDir: 'C:\\Users\\t\\.myelin\\token-optimizer',
      existsSync: () => false, skipDoctor: true,
    });
    assert.ok(!plan.commands.some(c => c.includes('copilot-doctor')), 'copilot-doctor must be absent on Windows too');
    assert.equal(plan.commands.length, 1);
  });
});

describe('installTokenOptimizerForCopilot', () => {
  const cloneDir = '/Users/alice/.myelin/token-optimizer';

  it('always prints the license warning before running darwin/linux commands', () => {
    const consoleCapture = captureConsole();
    const execStub = makeExecStub();
    const execFileStub = makeExecFileStub();

    const result = installTokenOptimizerForCopilot({
      os: 'darwin',
      cloneDir,
      exec: execStub.exec,
      execFile: execFileStub.execFile,
      log: consoleCapture.log,
      warn: consoleCapture.warn,
    });

    assert.deepEqual(consoleCapture.events[0], {
      type: 'warn',
      message: tokenOptimizerLicenseNotice(),
    });
    // git checkout runs via execFile (argv) — cloneDir is an inert argument.
    assert.deepEqual(execFileStub.calls.map((c) => ({ file: c.file, args: c.args })), [
      { file: 'git', args: ['clone', '--depth', '1', 'https://github.com/alexgreensh/token-optimizer.git', cloneDir] },
    ]);
    // exec only runs the two fixed-literal commands, each with cwd=cloneDir.
    assert.deepEqual(execStub.calls.map(call => call.command), [
      'bash install.sh --copilot',
      'TOKEN_OPTIMIZER_RUNTIME=copilot python3 skills/token-optimizer/scripts/measure.py copilot-doctor',
    ]);
    assert.equal(execStub.calls[0].options.cwd, cloneDir);
    assert.equal(execStub.calls[1].options.cwd, cloneDir);
    assert.deepEqual(result, {
      attempted: true,
      succeeded: true,
      manual: false,
      cloneDir,
    });
  });

  it('installs natively on win32 via py -3 when the launcher is available', () => {
    const consoleCapture = captureConsole();
    const execStub = makeExecStub();
    const execFileStub = makeExecFileStub();
    const cloneDir = 'C:\\Users\\alice\\.myelin\\token-optimizer';

    const result = installTokenOptimizerForCopilot({
      os: 'win32',
      cloneDir,
      exec: execStub.exec,
      execFile: execFileStub.execFile,
      existsSync: () => false,
      log: consoleCapture.log,
      warn: consoleCapture.warn,
    });

    assert.deepEqual(consoleCapture.events[0], {
      type: 'warn',
      message: tokenOptimizerLicenseNotice(),
    });
    // py -3 --version probe + the two install commands run via exec (shell);
    // the git checkout runs via execFile (argv).
    assert.deepEqual(execStub.calls.map(call => call.command), [
      'py -3 --version',
      'set "TOKEN_OPTIMIZER_RUNTIME=copilot" && py -3 skills/token-optimizer/scripts/measure.py copilot-install',
      'set "TOKEN_OPTIMIZER_RUNTIME=copilot" && py -3 skills/token-optimizer/scripts/measure.py copilot-doctor',
    ]);
    assert.equal(execStub.calls[0].options.stdio, 'pipe');
    assert.equal(execStub.calls[1].options.cwd, cloneDir);
    assert.equal(execStub.calls[2].options.cwd, cloneDir);
    assert.deepEqual(execFileStub.calls.map((c) => ({ file: c.file, args: c.args })), [
      { file: 'git', args: ['clone', '--depth', '1', 'https://github.com/alexgreensh/token-optimizer.git', cloneDir] },
    ]);
    assert.deepEqual(result, {
      attempted: true,
      succeeded: true,
      manual: false,
      cloneDir,
    });
  });

  it('prints the fallback Windows instructions when py -3 is unavailable', () => {
    const consoleCapture = captureConsole();
    const execStub = makeExecStub({ failOn: 'py -3 --version' });
    const execFileStub = makeExecFileStub();

    const result = installTokenOptimizerForCopilot({
      os: 'win32',
      cloneDir: 'C:\\Users\\alice\\.myelin\\token-optimizer',
      exec: execStub.exec,
      execFile: execFileStub.execFile,
      existsSync: () => false,
      log: consoleCapture.log,
      warn: consoleCapture.warn,
    });

    assert.deepEqual(consoleCapture.events[0], {
      type: 'warn',
      message: tokenOptimizerLicenseNotice(),
    });
    assert.equal(execStub.calls.length, 1);
    assert.equal(execFileStub.calls.length, 0);
    const output = consoleCapture.events.map(event => event.message).join('\n');
    assert.match(output, /Install Python 3 from https:\/\/python\.org\/downloads/i);
    assert.match(output, /legacy WSL flow/i);
    assert.match(output, /bash install\.sh --copilot/);
    assert.deepEqual(result, {
      attempted: false,
      succeeded: false,
      manual: true,
      cloneDir: 'C:\\Users\\alice\\.myelin\\token-optimizer',
      reason: 'py-launcher-missing',
    });
  });

  it('gracefully warns and returns a failure result when a command throws', () => {
    const consoleCapture = captureConsole();
    const execStub = makeExecStub({ failOn: 'bash install.sh --copilot' });
    const execFileStub = makeExecFileStub();

    const result = installTokenOptimizerForCopilot({
      os: 'linux',
      cloneDir,
      exec: execStub.exec,
      execFile: execFileStub.execFile,
      log: consoleCapture.log,
      warn: consoleCapture.warn,
    });

    assert.deepEqual(consoleCapture.events[0], {
      type: 'warn',
      message: tokenOptimizerLicenseNotice(),
    });
    assert.equal(execFileStub.calls.length, 1); // git checkout ran via argv
    assert.equal(execStub.calls.length, 1);     // failed on the first shell command
    assert.match(consoleCapture.events.map(event => event.message).join('\n'), /token-optimizer install failed/i);
    assert.equal(result.attempted, true);
    assert.equal(result.succeeded, false);
    assert.equal(result.manual, false);
    assert.equal(result.cloneDir, cloneDir);
    assert.match(result.error, /bash install\.sh --copilot failed hard/);
  });

  it('surfaces a git checkout failure without ever shelling the managed cloneDir', () => {
    const consoleCapture = captureConsole();
    const execStub = makeExecStub();
    const execFileStub = makeExecFileStub({ failOn: 'git clone' });

    const result = installTokenOptimizerForCopilot({
      os: 'linux',
      cloneDir,
      exec: execStub.exec,
      execFile: execFileStub.execFile,
      log: consoleCapture.log,
      warn: consoleCapture.warn,
    });

    assert.equal(execFileStub.calls.length, 1);
    assert.equal(execStub.calls.length, 0); // no shell command ran at all
    assert.equal(result.attempted, true);
    assert.equal(result.succeeded, false);
    assert.match(result.error, /git clone failed hard/);
  });
});

describe('installTokenOptimizerForCopilot — managed cloneDir is shell-inert', () => {
  it('runs a $()-laden cloneDir through execFile argv (no shell) and cwd (no `cd` string)', () => {
    const cloneDir = '/opt/$(touch pwned)/token-optimizer';
    const execStub = makeExecStub();
    const execFileStub = makeExecFileStub();

    installTokenOptimizerForCopilot({
      os: 'linux',
      cloneDir,
      exec: execStub.exec,
      execFile: execFileStub.execFile,
      existsSync: () => false,
      log: () => {},
      warn: () => {},
    });

    // git received the poisoned dir only as a discrete argv element.
    assert.equal(execFileStub.calls.length, 1);
    assert.equal(execFileStub.calls[0].file, 'git');
    assert.equal(execFileStub.calls[0].args.at(-1), cloneDir);
    // No shell command string carries the injection; cwd carries the dir instead.
    assert.ok(execStub.calls.every((c) => !c.command.includes('$(touch pwned)')), JSON.stringify(execStub.calls));
    assert.ok(execStub.calls.every((c) => c.options.cwd === cloneDir), JSON.stringify(execStub.calls));
  });
});

describe('tokenOptimizerCopilotInstallSteps — managed root relocation (MYELIN_DIR)', () => {
  it('roots the default clone dir under MYELIN_DIR when set', () => {
    const plan = tokenOptimizerCopilotInstallSteps({ os: 'linux', env: { MYELIN_DIR: '/custom/mroot' }, existsSync: () => false });
    assert.equal(plan.cloneDir, '/custom/mroot/token-optimizer');
    assert.equal(plan.checkout.args.at(-1), '/custom/mroot/token-optimizer');
  });

  it('defaults the clone dir under <home>/.myelin when MYELIN_DIR absent', () => {
    const plan = tokenOptimizerCopilotInstallSteps({ os: 'linux', env: {} });
    assert.ok(plan.cloneDir.includes(join('.myelin', 'token-optimizer')), plan.cloneDir);
    // Whether it clones or pulls, the managed cloneDir is an argv element (never shell).
    assert.ok(plan.checkout.args.includes(plan.cloneDir), JSON.stringify(plan.checkout));
  });
});

describe('tokenOptimizerWindowsManualInstructions — WSL flow must not hardcode ~/.myelin', () => {
  it('defaults to a shell-portable ~/.myelin clone dir when MYELIN_DIR is absent', () => {
    assert.equal(defaultWslCloneDir({ env: {} }), '~/.myelin/token-optimizer');
  });

  it('follows MYELIN_DIR when the managed root is relocated', () => {
    assert.equal(
      defaultWslCloneDir({ env: { MYELIN_DIR: '/custom/mroot' } }),
      '/custom/mroot/token-optimizer',
    );
  });

  it('emits WSL git clone/cd instructions rooted at the relocated MYELIN_DIR', () => {
    const lines = tokenOptimizerWindowsManualInstructions({ env: { MYELIN_DIR: '/custom/mroot' } });
    const text = lines.join('\n');
    assert.match(text, /legacy WSL flow/i);
    assert.ok(lines.includes('git clone --depth 1 https://github.com/alexgreensh/token-optimizer.git "/custom/mroot/token-optimizer"'), text);
    assert.ok(lines.includes('cd "/custom/mroot/token-optimizer"'), text);
    assert.ok(!text.includes('~/.myelin'), text);
  });

  it('keeps the ~/.myelin default in the printed WSL instructions when MYELIN_DIR is absent', () => {
    const lines = tokenOptimizerWindowsManualInstructions({ env: {} });
    assert.ok(lines.includes('cd "~/.myelin/token-optimizer"'), lines.join('\n'));
  });
});

describe('installTokenOptimizerForCopilot — WSL fallback honors MYELIN_DIR', () => {
  it('prints relocated WSL clone dir when py -3 is unavailable and MYELIN_DIR is set', () => {
    const events = [];
    const exec = (command) => {
      if (command.includes('py -3 --version')) throw new Error('missing');
      return Buffer.from('');
    };
    installTokenOptimizerForCopilot({
      os: 'win32',
      env: { MYELIN_DIR: '/custom/mroot' },
      cloneDir: 'C:\\Users\\alice\\managed\\token-optimizer',
      exec,
      existsSync: () => false,
      log: (m = '') => events.push(m),
      warn: () => {},
    });
    const output = events.join('\n');
    assert.match(output, /\/custom\/mroot\/token-optimizer/);
    assert.ok(!output.includes('~/.myelin'), output);
  });
});
