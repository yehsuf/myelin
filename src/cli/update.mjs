import { detectAll } from '../detect/tools.mjs';
import { execSync } from 'node:child_process';

const UPDATE_COMMANDS = {
  uv:       { upgrade: 'uv self update' },
  headroom: { upgrade: 'uv tool upgrade headroom-ai' },
  serena:   { upgrade: 'uv tool upgrade serena' },
  semble:   { upgrade: 'uv tool upgrade semble' },
  rtk:      { upgrade: 'brew upgrade rtk' },
  astgrep:  { upgrade: 'cargo install ast-grep --locked' },
};

export async function runUpdate(options = {}) {
  const { check = false } = options;
  const tools = await detectAll();
  console.log(`\nTokenStack Update ${check ? '(dry-run)' : ''}\n${'─'.repeat(55)}`);
  for (const [name, r] of Object.entries(tools)) {
    const cmd = UPDATE_COMMANDS[name];
    if (!cmd) continue;
    const icon = r.installed ? '↑' : '+';
    const status = r.installed ? `installed (${r.version})` : 'not installed';
    console.log(`  ${icon} ${name.padEnd(12)} ${status}`);
    if (!check) {
      try { execSync(cmd.upgrade, { stdio: 'inherit' }); console.log('    ✓ done'); }
      catch (e) { console.warn(`    ✗ failed: ${e.message}`); }
    } else {
      console.log(`    → would run: ${cmd.upgrade}`);
    }
  }
  console.log('─'.repeat(55));
  if (check) console.log('  Run without --check to apply updates.\n');
  else console.log('  Run: tokenstack verify to confirm.\n');
}
