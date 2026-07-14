import { detectAll } from '../detect/tools.mjs';
import { execSync } from 'node:child_process';
import { detectOS } from '../detect/os.mjs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { DEFAULT_CONFIG_PATH, readUserConfig } from '../config/reader.mjs';
import { DEFAULT_CONFIG, listUnknownKeyPaths } from '../config/schema.mjs';
import { stageMainRuntime } from '../runtime/stage-main.mjs';
import { writeManagedLauncher } from '../runtime/launcher.mjs';
import { managedPaths } from '../shared/myelin-paths.mjs';

const MANAGED_MAIN_REPO_URL = 'https://github.com/yehsuf/myelin';

function upgradeCommands(os, { home = homedir(), env = process.env } = {}) {
  // Resolve the managed venv through managedPaths so a relocated MYELIN_DIR is
  // honored — headroom lives in the managed root's venv, not a hardcoded
  // ~/.myelin/venv.
  const venv = managedPaths({ home, env, platform: os }).venvPath;
  return {
    uv:       { upgrade: 'uv self update' },
    // headroom installed via uv pip in venv, not uv tool
    headroom: { upgrade: `uv pip install --python "${venv}" --upgrade "headroom-ai[all]"` },
    // serena installed via uv tool as 'serena-agent'
    // No --python flag on upgrade: reuse whatever Python is in the existing env.
    // --python 3.12 is only used on fresh install (install.mjs) to avoid the
    // "Ignoring existing environment: interpreter mismatch" rebuild on every update.
    serena:   { upgrade: 'uv tool install --force "serena-agent @ git+https://github.com/oraios/serena.git"' },
    semble:   { upgrade: 'uv tool install --force "semble[mcp]"' },
    rtk: {
      upgrade: os === 'darwin' ? 'brew upgrade rtk'
             : os === 'windows' ? null   // GitHub release — handled separately
             : 'uv tool upgrade rtk',
    },
    astgrep: {
      upgrade: os === 'darwin' ? 'brew upgrade ast-grep'
             : os === 'windows' ? 'npm update -g @ast-grep/cli'
             : 'npm update -g @ast-grep/cli',
    },
  };
}

const _UPGRADE_STOP_PROCESS = {
  headroom: ['headroom'],
  serena: ['serena-agent'],
  semble: ['semble'],
};

export function _stopForUpgrade(name, execSyncFn = execSync) {
  const names = _UPGRADE_STOP_PROCESS[name];
  if (!names) return;
  const joined = names.map(processName => `'${processName}'`).join(',');
  try {
    execSyncFn(
      `powershell -Command "Get-Process -Name ${joined} -ErrorAction SilentlyContinue | Stop-Process -Force"`,
      { stdio: 'pipe', timeout: 5000 }
    );
    const start = Date.now();
    while (Date.now() - start < 500) {}
  } catch {}
}

function repoDirFromMetaUrl(metaUrl = import.meta.url) {
  return join(dirname(fileURLToPath(metaUrl)), '..', '..');
}

export async function checkStaleConfigKeys({
  configPath = DEFAULT_CONFIG_PATH,
  warn = console.warn,
  existsSyncFn = existsSync,
  readUserConfigFn = readUserConfig,
  schema = DEFAULT_CONFIG,
} = {}) {
  if (!existsSyncFn(configPath)) return { exists: false, staleKeys: [] };

  const rawUserConfig = await readUserConfigFn(configPath, warn);
  const staleKeys = listUnknownKeyPaths(rawUserConfig, schema);
  if (staleKeys.length === 0) return { exists: true, staleKeys };

  warn(`ℹ Your ${configPath} has ${staleKeys.length} stale config key(s) no longer used by this version.`);
  warn('  Run: myelin config prune --dry-run to preview, or myelin config prune to clean them up.');
  return { exists: true, staleKeys };
}

export async function runUpdate(options = {}, deps = {}) {
  const { check = false } = options;
  const home = deps.home ?? homedir();
  const env = deps.env ?? process.env;
  const os = deps.os ?? (deps.detectOSFn ?? detectOS)();
  const tools = await (deps.detectAllFn ?? detectAll)();
  const exec = deps.execSyncFn ?? execSync;
  const log = deps.log ?? console.log;
  const warn = deps.warn ?? console.warn;
  const cmds = upgradeCommands(os, { home, env });
  const repoDir = repoDirFromMetaUrl();
  const installerCmd = `node "${join(repoDir, 'src', 'install.mjs')}" --yes`;
  log(`\nMyelin Update ${check ? '(dry-run)' : ''}\n${'─'.repeat(55)}`);
  for (const [name, r] of Object.entries(tools)) {
    const cmd = cmds[name];
    if (!cmd) continue;
    const icon = r.installed ? '↑' : '+';
    const label = name === 'headroom' ? 'headroom proxy' : name;
    const status = r.installed ? `${r.version ?? 'installed'}` : 'not installed';
    log(`  ${icon} ${label.padEnd(14)} ${status}`);
    if (!check) {
      if (!cmd.upgrade) { log(`    · no auto-update — reinstall: ${installerCmd}`); continue; }
      if (os === 'windows') _stopForUpgrade(name);
      try { exec(cmd.upgrade, { stdio: 'inherit' }); log('    ✓ done'); }
      catch (e) {
        const msg = e?.message ?? String(e);
        const isLocked = /os error (32|5)|Access is denied|cannot access the file/i.test(msg);
        if (os === 'windows' && isLocked) {
          warn('    ✗ failed: file locked — close Claude Code / Copilot sessions and re-run: myelin update');
        } else {
          warn(`    ✗ failed: ${msg.split('\n')[0]}`);
        }
      }
    } else {
      log(`    → ${cmd.upgrade ?? '(manual)'}`);
    }
  }
  log('─'.repeat(55));
  if (check) log('  Run without --check to apply updates.\n');
  if (!check) {
    const runRestartFn = deps.runRestartFn ?? (async () => {
      const { runRestart } = await import('./restart.mjs');
      return runRestart();
    });
    await runRestartFn();
  }
  else log('  Run: myelin verify to confirm.\n');
}

export async function runSelfUpdate(options = {}, deps = {}) {
  const log = deps.log ?? console.log;
  const warn = deps.warn ?? console.warn;
  const home = deps.home ?? homedir();
  const os = deps.os ?? detectOS();
  const repoUrl = deps.repoUrl ?? MANAGED_MAIN_REPO_URL;
  const stageMainRuntimeFn = deps.stageMainRuntimeFn ?? stageMainRuntime;
  const writeManagedLauncherFn = deps.writeManagedLauncherFn ?? writeManagedLauncher;

  log('\n🧬 Myelin Self-Update\n' + '─'.repeat(40));
  try {
    const staged = stageMainRuntimeFn({ home, repoUrl });
    const launcher = writeManagedLauncherFn({ home, os });
    log(`  ✓ Selected release: ${staged.releaseId}`);
    log(`  ↳ Managed command: ${launcher.commandPath}\n`);
    return { status: 'updated', ...staged, ...launcher };
  } catch (e) {
    warn(`  ✗ Self-update failed: ${e.message.split('\n')[0]}\n`);
    return { status: 'failed', error: e };
  }
}

export function runDeprecatedSelfUpdate({ error = console.error } = {}) {
  const message = '`myelin update --self` is deprecated; run `myelin self update`.';
  error(message);
  return { status: 'deprecated', exitCode: 1, message };
}
