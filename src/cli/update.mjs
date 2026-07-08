import { detectAll } from '../detect/tools.mjs';
import { execSync } from 'node:child_process';
import { detectOS } from '../detect/os.mjs';
import { join } from 'node:path';
import { homedir } from 'node:os';

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

export async function runUpdate(options = {}) {
  const { check = false } = options;
  const os = detectOS();
  const tools = await detectAll();
  const cmds = upgradeCommands(os);
  console.log(`\nMyelin Update ${check ? '(dry-run)' : ''}\n${'─'.repeat(55)}`);
  for (const [name, r] of Object.entries(tools)) {
    const cmd = cmds[name];
    if (!cmd) continue;
    const icon = r.installed ? '↑' : '+';
    const label = name === 'headroom' ? 'headroom proxy' : name;
    const status = r.installed ? `${r.version ?? 'installed'}` : 'not installed';
    console.log(`  ${icon} ${label.padEnd(14)} ${status}`);
    if (!check) {
      if (!cmd.upgrade) { console.log(`    · no auto-update — reinstall: node src/install.mjs --yes`); continue; }
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

export async function runSelfUpdate() {
  const { execSync } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const { join, dirname } = await import('node:path');
  const repoDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

  console.log('\n🧬 Myelin Self-Update\n' + '─'.repeat(40));
  try {
    const current = execSync('git rev-parse --short HEAD', { cwd: repoDir, stdio: 'pipe' }).toString().trim();
    execSync('git fetch origin', { cwd: repoDir, stdio: 'pipe' });
    const latest = execSync('git rev-parse --short origin/main', { cwd: repoDir, stdio: 'pipe' }).toString().trim();
    if (current === latest) {
      console.log(`  ✓ Already up to date (${current})\n`);
      return;
    }
    console.log(`  Updating ${current} → ${latest}...`);
    execSync('git reset --hard origin/main', { cwd: repoDir, stdio: 'pipe' });
    execSync('npm install --registry https://registry.npmjs.org', { cwd: repoDir, stdio: 'pipe' });
    console.log(`  ✓ Updated to ${latest}`);
    console.log(`  ↳ Run: node src/install.mjs --yes  to apply config changes\n`);
  } catch (e) {
    console.warn(`  ✗ Self-update failed: ${e.message.split('\n')[0]}\n`);
  }
}
