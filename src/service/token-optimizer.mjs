import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const TOKEN_OPTIMIZER_REPO_URL = 'https://github.com/alexgreensh/token-optimizer';
const TOKEN_OPTIMIZER_GIT_URL = `${TOKEN_OPTIMIZER_REPO_URL}.git`;
const DEFAULT_WSL_CLONE_DIR = '~/.myelin/token-optimizer';
const nodeExecSync = execSync;
const nodeExistsSync = existsSync;
const WINDOWS_PYTHON_LAUNCHER = 'py -3';

function isWindowsOs(os) {
  return os === 'windows' || os === 'win32';
}

function defaultCloneDir(os = process.platform) {
  return join(homedir(), '.myelin', 'token-optimizer');
}

function checkoutCommands({ cloneDir, existsSync: existsSyncImpl = nodeExistsSync } = {}) {
  return existsSyncImpl(`${cloneDir}/.git`)
    ? [`git -C "${cloneDir}" pull --ff-only`]
    : [`git clone --depth 1 ${TOKEN_OPTIMIZER_GIT_URL} "${cloneDir}"`];
}

function tokenOptimizerCopilotDoctorCommand(os) {
  return isWindowsOs(os)
    ? `set "TOKEN_OPTIMIZER_RUNTIME=copilot" && ${WINDOWS_PYTHON_LAUNCHER} skills/token-optimizer/scripts/measure.py copilot-doctor`
    : 'TOKEN_OPTIMIZER_RUNTIME=copilot python3 skills/token-optimizer/scripts/measure.py copilot-doctor';
}

function tokenOptimizerCopilotInstallCommand(os) {
  return isWindowsOs(os)
    ? `set "TOKEN_OPTIMIZER_RUNTIME=copilot" && ${WINDOWS_PYTHON_LAUNCHER} skills/token-optimizer/scripts/measure.py copilot-install`
    : 'bash install.sh --copilot';
}

function tokenOptimizerWindowsManualInstructions() {
  return [
    'Windows native install requires the Windows Python Launcher (`py -3`).',
    'Install Python 3 from https://python.org/downloads then re-run `myelin install`.',
    'If you prefer the legacy WSL flow, run this from inside a WSL shell:',
    `git clone --depth 1 ${TOKEN_OPTIMIZER_GIT_URL} "${DEFAULT_WSL_CLONE_DIR}"`,
    `cd "${DEFAULT_WSL_CLONE_DIR}"`,
    'bash install.sh --copilot',
    'TOKEN_OPTIMIZER_RUNTIME=copilot python3 skills/token-optimizer/scripts/measure.py copilot-doctor',
  ];
}

export function tokenOptimizerLicenseNotice() {
  return `token-optimizer (${TOKEN_OPTIMIZER_REPO_URL}) is licensed
  under PolyForm Noncommercial License 1.0.0.
  Free for personal, educational, government, and noncommercial use.
  Company/commercial use requires a separate license — see the
  project's LICENSE file or contact the author before enabling this
  for your employer's work.`;
}

export function tokenOptimizerClaudeCodeInstructions() {
  return [
    'Claude Code install is manual — run these inside a Claude Code session:',
    '/plugin marketplace add alexgreensh/token-optimizer',
    '/plugin install token-optimizer@alexgreensh-token-optimizer',
    'Then run /token-optimizer once for the one-time hook setup.',
  ].join('\n');
}

export function tokenOptimizerCopilotInstallSteps({
  os = process.platform,
  cloneDir = defaultCloneDir(os),
  existsSync: existsSyncImpl = nodeExistsSync,
} = {}) {
  const commands = [
    ...checkoutCommands({ cloneDir, existsSync: existsSyncImpl }),
    `cd "${cloneDir}"`,
    tokenOptimizerCopilotInstallCommand(os),
    tokenOptimizerCopilotDoctorCommand(os),
  ];
  return { automatable: true, commands, manualInstructions: [] };
}

export function installTokenOptimizerForCopilot({
  os = process.platform,
  cloneDir = defaultCloneDir(os),
  exec = nodeExecSync,
  existsSync: existsSyncImpl = nodeExistsSync,
  log = console.log,
  warn = console.warn,
} = {}) {
  warn(tokenOptimizerLicenseNotice());

  if (isWindowsOs(os)) {
    try {
      exec(`${WINDOWS_PYTHON_LAUNCHER} --version`, { stdio: 'pipe' });
    } catch {
      tokenOptimizerWindowsManualInstructions().forEach(line => log(line));
      return {
        attempted: false,
        succeeded: false,
        manual: true,
        cloneDir,
        reason: 'py-launcher-missing',
      };
    }
  }

  const plan = tokenOptimizerCopilotInstallSteps({ os, cloneDir, existsSync: existsSyncImpl });
  if (!plan.automatable) {
    plan.manualInstructions.forEach(line => log(line));
    return { attempted: false, succeeded: false, manual: true, cloneDir };
  }

  let cwd = null;
  try {
    log('Installing token-optimizer for Copilot CLI...');
    for (const command of plan.commands) {
      if (command.startsWith('cd ')) {
        cwd = cloneDir;
        log(command);
        continue;
      }
      log(command);
      exec(command, { stdio: 'inherit', ...(cwd ? { cwd } : {}) });
    }
    log('✓ token-optimizer Copilot install complete');
    return { attempted: true, succeeded: true, manual: false, cloneDir };
  } catch (error) {
    warn(`token-optimizer install failed — ${error.message.split('\n')[0]}`);
    log('Retry manually with:');
    plan.commands.forEach(command => log(command));
    return {
      attempted: true,
      succeeded: false,
      manual: false,
      cloneDir,
      error: error.message,
    };
  }
}
