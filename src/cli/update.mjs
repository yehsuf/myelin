import { detectAll } from '../detect/tools.mjs';
import { execSync } from 'node:child_process';
import { detectOS } from '../detect/os.mjs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

function upgradeCommands(os) {
  const venv = join(homedir(), '.myelin', 'venv');
  return {
    uv:       { upgrade: 'uv self update' },
    // headroom installed via uv pip in venv, not uv tool
    headroom: { upgrade: `uv pip install --python "${venv}" --upgrade "headroom-ai[all]"` },
    // serena installed via uv tool as 'serena-agent'
    serena:   { upgrade: 'uv tool install --python 3.12 --force "serena-agent @ git+https://github.com/oraios/serena.git"' },
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

export function isRepoDirty(repoDir) {
  return execSync('git status --porcelain -- . ":(exclude).serena"', { cwd: repoDir, stdio: 'pipe' }).toString().trim();
}

function repoDirFromMetaUrl(metaUrl = import.meta.url) {
  return join(dirname(fileURLToPath(metaUrl)), '..', '..');
}

export function checkSelfUpdateWorkingTree({ repoDir, force = false, warn = console.warn, isRepoDirtyFn = isRepoDirty } = {}) {
  const dirty = isRepoDirtyFn(repoDir);
  if (!dirty) return { dirty: false, bypassed: false, aborted: false };
  if (!force) {
    warn('  ✗ Uncommitted changes present — aborting self-update to avoid data loss.');
    warn('    Commit or stash your changes, then re-run: myelin update --self\n');
    return { dirty: true, bypassed: false, aborted: true };
  }
  warn('  ⚠ Uncommitted changes present but --force specified — proceeding anyway.');
  warn('    Your local changes will NOT be touched by the update itself if git can fast-forward safely; review git status afterward.\n');
  return { dirty: true, bypassed: true, aborted: false };
}

export async function runUpdate(options = {}) {
  const { check = false } = options;
  const os = detectOS();
  const tools = await detectAll();
  const cmds = upgradeCommands(os);
  const repoDir = repoDirFromMetaUrl();
  const installerCmd = `node "${join(repoDir, 'src', 'install.mjs')}" --yes`;
  console.log(`\nMyelin Update ${check ? '(dry-run)' : ''}\n${'─'.repeat(55)}`);
  for (const [name, r] of Object.entries(tools)) {
    const cmd = cmds[name];
    if (!cmd) continue;
    const icon = r.installed ? '↑' : '+';
    const label = name === 'headroom' ? 'headroom proxy' : name;
    const status = r.installed ? `${r.version ?? 'installed'}` : 'not installed';
    console.log(`  ${icon} ${label.padEnd(14)} ${status}`);
    if (!check) {
      if (!cmd.upgrade) { console.log(`    · no auto-update — reinstall: ${installerCmd}`); continue; }
      try { execSync(cmd.upgrade, { stdio: 'inherit' }); console.log('    ✓ done'); }
      catch (e) { console.warn(`    ✗ failed: ${e.message.split('\n')[0]}`); }
    } else {
      console.log(`    → ${cmd.upgrade ?? '(manual)'}`);
    }
  }
  console.log('─'.repeat(55));
  if (check) console.log('  Run without --check to apply updates.\n');
  if (!check) {
    const { runRestart } = await import('./restart.mjs');
    await runRestart();
  }
  else console.log('  Run: myelin verify to confirm.\n');
}

export async function runSelfUpdate(options = {}, deps = {}) {
  const { force = false } = options;
  const exec = deps.execSync ?? execSync;
  const log = deps.log ?? console.log;
  const warn = deps.warn ?? console.warn;
  const repoDir = deps.repoDir ?? repoDirFromMetaUrl();

  log('\n🧬 Myelin Self-Update\n' + '─'.repeat(40));
  try {
    const workingTree = checkSelfUpdateWorkingTree({ repoDir, force, warn });
    if (workingTree.aborted) return { status: 'aborted-dirty', ...workingTree };

    const current = exec('git rev-parse --short HEAD', { cwd: repoDir, stdio: 'pipe' }).toString().trim();
    exec('git fetch origin', { cwd: repoDir, stdio: 'pipe' });
    const latest = exec('git rev-parse --short origin/main', { cwd: repoDir, stdio: 'pipe' }).toString().trim();
    if (current === latest) {
      log(`  ✓ Already up to date (${current})\n`);
      return { status: 'up-to-date', current, latest, ...workingTree };
    }

    // Safety gate 2: refuse to discard unpushed local commits.
    const unpushed = exec('git log origin/main..HEAD --oneline', { cwd: repoDir, stdio: 'pipe' }).toString().trim();
    if (unpushed) {
      warn('  ✗ Local commits not on origin/main would be lost — aborting self-update:');
      unpushed.split('\n').forEach(l => warn(`      ${l}`));
      warn('    Push these commits first, then re-run: myelin update --self\n');
      return { status: 'aborted-unpushed', current, latest, ...workingTree };
    }

    log(`  Updating ${current} → ${latest}...`);
    // Fast-forward only — never force-discard history. Fails safely if diverged.
    exec('git merge --ff-only origin/main', { cwd: repoDir, stdio: 'pipe' });
    exec('npm install --registry https://registry.npmjs.org', { cwd: repoDir, stdio: 'pipe' });
    log(`  ✓ Updated to ${latest}`);
    // Re-run installer to apply config changes (service files, shell profile, MCP config)
    log(`  ↳ Applying config changes...`);
    try {
      exec(`node "${join(repoDir, 'src', 'install.mjs')}" --yes`, { stdio: 'inherit', cwd: repoDir });
    } catch (e) {
      warn(`  ⚠ Installer failed: ${e.message.split('\n')[0]}`);
      warn(`  ↳ Run manually: node "${join(repoDir, 'src', 'install.mjs')}" --yes`);
    }
    log();
    return { status: 'updated', current, latest, ...workingTree };
  } catch (e) {
    warn(`  ✗ Self-update failed: ${e.message.split('\n')[0]}\n`);
    return { status: 'failed', error: e };
  }
}
