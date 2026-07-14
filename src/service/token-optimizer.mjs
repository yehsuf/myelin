import { execSync, execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { hardenCopilotHookFile } from '../tools/hook-safety.mjs';
import { managedPaths, joinManaged } from '../shared/myelin-paths.mjs';

const TOKEN_OPTIMIZER_REPO_URL = 'https://github.com/alexgreensh/token-optimizer';
const TOKEN_OPTIMIZER_GIT_URL = `${TOKEN_OPTIMIZER_REPO_URL}.git`;
const nodeExecSync = execSync;
const nodeExecFileSync = execFileSync;
const nodeExistsSync = existsSync;
const WINDOWS_PYTHON_LAUNCHER = 'py -3';

function isWindowsOs(os) {
  return os === 'windows' || os === 'win32';
}

export function defaultCloneDir({ os = process.platform, env = process.env, home = homedir() } = {}) {
  return joinManaged(managedPaths({ home, env, platform: os }).root, 'token-optimizer');
}

/**
 * WSL clone dir for the legacy manual flow. The instructions run inside a WSL
 * shell (a different home than the Windows host), so this keeps a shell-portable
 * `~/.myelin` default rather than an absolute Windows path — but it must NOT
 * hardcode `~/.myelin`: when MYELIN_DIR relocates the managed root, the printed
 * instructions follow it.
 */
export function defaultWslCloneDir({ env = process.env } = {}) {
  const root = typeof env?.MYELIN_DIR === 'string' && env.MYELIN_DIR.trim()
    ? env.MYELIN_DIR
    : '~/.myelin';
  return `${root}/token-optimizer`;
}

/**
 * Git checkout/refresh plan as an executable + argv ARRAY — never a shell
 * string. The managed `cloneDir` (MYELIN_DIR-derived; may contain spaces, `$()`,
 * quotes) is passed as a discrete argv element to `git`, so no shell ever parses
 * it. Callers run it via execFileSync(file, args) (no `shell: true`).
 */
function checkoutPlan({ cloneDir, existsSync: existsSyncImpl = nodeExistsSync } = {}) {
  return existsSyncImpl(`${cloneDir}/.git`)
    ? { file: 'git', args: ['-C', cloneDir, 'pull', '--ff-only'] }
    : { file: 'git', args: ['clone', '--depth', '1', TOKEN_OPTIMIZER_GIT_URL, cloneDir] };
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

export function tokenOptimizerWindowsManualInstructions({ env = process.env } = {}) {
  const wslCloneDir = defaultWslCloneDir({ env });
  return [
    'Windows native install requires the Windows Python Launcher (`py -3`).',
    'Install Python 3 from https://python.org/downloads then re-run `myelin install`.',
    'If you prefer the legacy WSL flow, run this from inside a WSL shell:',
    `git clone --depth 1 ${TOKEN_OPTIMIZER_GIT_URL} "${wslCloneDir}"`,
    `cd "${wslCloneDir}"`,
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

/** Path to the Copilot hook file the token-optimizer installer writes. */
export function copilotTokenOptimizerHookPath(home = homedir()) {
  return join(home, '.copilot', 'hooks', 'token-optimizer.json');
}

/**
 * Make token-optimizer's Copilot preToolUse hook fail-open. The external
 * installer writes an unguarded python-bridge command, so a bridge crash or a
 * missing python interpreter would fail-CLOSE every bash tool call. This wraps
 * the preToolUse command so a crash becomes exit 0 while an intentional exit-2
 * deny is preserved. No-op if the hook is absent or already hardened.
 */
export function hardenCopilotTokenOptimizerHook({ home = homedir(), fs } = {}) {
  return hardenCopilotHookFile({
    path: copilotTokenOptimizerHookPath(home),
    events: ['preToolUse', 'PreToolUse'],
    fields: ['bash'],
    preserveDeny: true,
    ...(fs ? { fs } : {}),
  });
}

export function tokenOptimizerCopilotInstallSteps({
  os = process.platform,
  env = process.env,
  cloneDir = defaultCloneDir({ os, env }),
  existsSync: existsSyncImpl = nodeExistsSync,
} = {}) {
  // `checkout` is an argv plan (git file+args) run via execFileSync — the managed
  // cloneDir never touches a shell. `commands` are fixed literals (no managed
  // path) run with cwd=cloneDir, so nothing managed is spliced into a shell here.
  const checkout = checkoutPlan({ cloneDir, existsSync: existsSyncImpl });
  const commands = [
    tokenOptimizerCopilotInstallCommand(os),
    tokenOptimizerCopilotDoctorCommand(os),
  ];
  return { automatable: true, cloneDir, checkout, commands, manualInstructions: [] };
}

export function installTokenOptimizerForCopilot({
  os = process.platform,
  env = process.env,
  cloneDir = defaultCloneDir({ os, env }),
  exec = nodeExecSync,
  execFile = nodeExecFileSync,
  existsSync: existsSyncImpl = nodeExistsSync,
  log = console.log,
  warn = console.warn,
} = {}) {
  warn(tokenOptimizerLicenseNotice());

  if (isWindowsOs(os)) {
    try {
      exec(`${WINDOWS_PYTHON_LAUNCHER} --version`, { stdio: 'pipe' });
    } catch {
      tokenOptimizerWindowsManualInstructions({ env }).forEach(line => log(line));
      return {
        attempted: false,
        succeeded: false,
        manual: true,
        cloneDir,
        reason: 'py-launcher-missing',
      };
    }
  }

  const plan = tokenOptimizerCopilotInstallSteps({ os, env, cloneDir, existsSync: existsSyncImpl });
  if (!plan.automatable) {
    plan.manualInstructions.forEach(line => log(line));
    return { attempted: false, succeeded: false, manual: true, cloneDir };
  }

  try {
    log('Installing token-optimizer for Copilot CLI...');
    // Checkout via execFileSync argv — managed cloneDir is an inert git argument.
    log(`git ${plan.checkout.args.join(' ')}`);
    execFile(plan.checkout.file, plan.checkout.args, { stdio: 'inherit' });
    // Remaining commands are fixed literals; run them inside the checkout dir via
    // cwd (never a `cd "<managed>" && …` shell string).
    for (const command of plan.commands) {
      log(command);
      exec(command, { stdio: 'inherit', cwd: cloneDir });
    }
    log('✓ token-optimizer Copilot install complete');
    return { attempted: true, succeeded: true, manual: false, cloneDir };
  } catch (error) {
    warn(`token-optimizer install failed — ${error.message.split('\n')[0]}`);
    log('Retry manually with:');
    log(`git ${plan.checkout.args.join(' ')}`);
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
