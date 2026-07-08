import { detectAll } from '../detect/tools.mjs';
import { execSync } from 'node:child_process';
import { detectOS } from '../detect/os.mjs';
import { join } from 'node:path';
import { homedir } from 'node:os';

function upgradeCommands(os) {
  const venv = join(homedir(), '.tokenstack', 'venv');
  return {
    uv:       { upgrade: 'uv self update' },
    // headroom installed via uv pip in venv, not uv tool
    headroom: { upgrade: `uv pip install --python "${venv}" --upgrade "headroom-ai[all]"` },
    // serena installed via uv tool as 'serena-agent'
    serena:   { upgrade: 'uv tool install --python 3.12 --force "serena-agent @ git+https://github.com/oraios/serena.git"' },
    semble:   { upgrade: 'uv tool upgrade semble' },
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
  else console.log('  Run: myelin verify to confirm.\n');
}
