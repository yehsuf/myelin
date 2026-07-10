import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  installTokenOptimizerForCopilot,
  tokenOptimizerClaudeCodeInstructions,
  tokenOptimizerCopilotInstallSteps,
  tokenOptimizerLicenseNotice,
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

describe('tokenOptimizerCopilotInstallSteps', () => {
  const cloneDir = '/Users/alice/.myelin/token-optimizer';

  it('returns automatable darwin steps with clone/install commands', () => {
    const plan = tokenOptimizerCopilotInstallSteps({ os: 'darwin', cloneDir });
    assert.equal(plan.automatable, true);
    assert.deepEqual(plan.commands, [
      `git clone --depth 1 https://github.com/alexgreensh/token-optimizer.git "${cloneDir}"`,
      `cd "${cloneDir}"`,
      'bash install.sh --copilot',
      'TOKEN_OPTIMIZER_RUNTIME=copilot python3 skills/token-optimizer/scripts/measure.py copilot-doctor',
    ]);
    assert.deepEqual(plan.manualInstructions, []);
  });

  it('returns automatable linux steps with clone/install commands', () => {
    const plan = tokenOptimizerCopilotInstallSteps({ os: 'linux', cloneDir });
    assert.equal(plan.automatable, true);
    assert.equal(plan.commands[0], `git clone --depth 1 https://github.com/alexgreensh/token-optimizer.git "${cloneDir}"`);
    assert.equal(plan.commands[2], 'bash install.sh --copilot');
  });

  it('returns automatable win32 steps with py -3 native install commands', () => {
    const plan = tokenOptimizerCopilotInstallSteps({
      os: 'win32',
      cloneDir: 'C:\\Users\\alice\\.myelin\\token-optimizer',
      existsSync: () => false,
    });
    assert.equal(plan.automatable, true);
    assert.deepEqual(plan.commands, [
      'git clone --depth 1 https://github.com/alexgreensh/token-optimizer.git "C:\\Users\\alice\\.myelin\\token-optimizer"',
      'cd "C:\\Users\\alice\\.myelin\\token-optimizer"',
      'set "TOKEN_OPTIMIZER_RUNTIME=copilot" && py -3 skills/token-optimizer/scripts/measure.py copilot-install',
      'set "TOKEN_OPTIMIZER_RUNTIME=copilot" && py -3 skills/token-optimizer/scripts/measure.py copilot-doctor',
    ]);
    assert.deepEqual(plan.manualInstructions, []);
  });

  it('updates an existing win32 checkout instead of cloning again', () => {
    const cloneDir = 'C:\\Users\\alice\\.myelin\\token-optimizer';
    const plan = tokenOptimizerCopilotInstallSteps({
      os: 'win32',
      cloneDir,
      existsSync: path => path === `${cloneDir}/.git`,
    });
    assert.equal(plan.commands[0], `git -C "${cloneDir}" pull --ff-only`);
  });
});

describe('installTokenOptimizerForCopilot', () => {
  const cloneDir = '/Users/alice/.myelin/token-optimizer';

  it('always prints the license warning before running darwin/linux commands', () => {
    const consoleCapture = captureConsole();
    const execStub = makeExecStub();

    const result = installTokenOptimizerForCopilot({
      os: 'darwin',
      cloneDir,
      exec: execStub.exec,
      log: consoleCapture.log,
      warn: consoleCapture.warn,
    });

    assert.deepEqual(consoleCapture.events[0], {
      type: 'warn',
      message: tokenOptimizerLicenseNotice(),
    });
    assert.deepEqual(execStub.calls.map(call => call.command), [
      `git clone --depth 1 https://github.com/alexgreensh/token-optimizer.git "${cloneDir}"`,
      'bash install.sh --copilot',
      'TOKEN_OPTIMIZER_RUNTIME=copilot python3 skills/token-optimizer/scripts/measure.py copilot-doctor',
    ]);
    assert.equal(execStub.calls[0].options.cwd, undefined);
    assert.equal(execStub.calls[1].options.cwd, cloneDir);
    assert.equal(execStub.calls[2].options.cwd, cloneDir);
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
    const cloneDir = 'C:\\Users\\alice\\.myelin\\token-optimizer';

    const result = installTokenOptimizerForCopilot({
      os: 'win32',
      cloneDir,
      exec: execStub.exec,
      existsSync: () => false,
      log: consoleCapture.log,
      warn: consoleCapture.warn,
    });

    assert.deepEqual(consoleCapture.events[0], {
      type: 'warn',
      message: tokenOptimizerLicenseNotice(),
    });
    assert.deepEqual(execStub.calls.map(call => call.command), [
      'py -3 --version',
      `git clone --depth 1 https://github.com/alexgreensh/token-optimizer.git "${cloneDir}"`,
      'set "TOKEN_OPTIMIZER_RUNTIME=copilot" && py -3 skills/token-optimizer/scripts/measure.py copilot-install',
      'set "TOKEN_OPTIMIZER_RUNTIME=copilot" && py -3 skills/token-optimizer/scripts/measure.py copilot-doctor',
    ]);
    assert.equal(execStub.calls[0].options.stdio, 'pipe');
    assert.equal(execStub.calls[1].options.cwd, undefined);
    assert.equal(execStub.calls[2].options.cwd, cloneDir);
    assert.equal(execStub.calls[3].options.cwd, cloneDir);
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

    const result = installTokenOptimizerForCopilot({
      os: 'win32',
      cloneDir: 'C:\\Users\\alice\\.myelin\\token-optimizer',
      exec: execStub.exec,
      existsSync: () => false,
      log: consoleCapture.log,
      warn: consoleCapture.warn,
    });

    assert.deepEqual(consoleCapture.events[0], {
      type: 'warn',
      message: tokenOptimizerLicenseNotice(),
    });
    assert.equal(execStub.calls.length, 1);
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

  it('gracefully warns and returns a failure result when exec throws', () => {
    const consoleCapture = captureConsole();
    const execStub = makeExecStub({ failOn: 'bash install.sh --copilot' });

    const result = installTokenOptimizerForCopilot({
      os: 'linux',
      cloneDir,
      exec: execStub.exec,
      log: consoleCapture.log,
      warn: consoleCapture.warn,
    });

    assert.deepEqual(consoleCapture.events[0], {
      type: 'warn',
      message: tokenOptimizerLicenseNotice(),
    });
    assert.equal(execStub.calls.length, 2);
    assert.match(consoleCapture.events.map(event => event.message).join('\n'), /token-optimizer install failed/i);
    assert.equal(result.attempted, true);
    assert.equal(result.succeeded, false);
    assert.equal(result.manual, false);
    assert.equal(result.cloneDir, cloneDir);
    assert.match(result.error, /bash install\.sh --copilot failed hard/);
  });
});
