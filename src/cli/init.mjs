import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

function findGitRoot(dir) {
  let d = dir;
  while (d !== join(d, '..')) {
    if (existsSync(join(d, '.git'))) return d;
    d = join(d, '..');
  }
  return null;
}

async function prompt(rl, question) {
  return new Promise(r => rl.question(question, r));
}

async function confirm(rl, question, defaultYes = true) {
  const hint = defaultYes ? '[Y/n]' : '[y/N]';
  const ans = (await prompt(rl, `${question} ${hint} `)).trim().toLowerCase();
  return ans === '' ? defaultYes : ans === 'y' || ans === 'yes';
}

const TOOLS = [
  {
    id: 'serena',
    label: 'Serena (LSP code index — enables symbol-precise navigation)',
    check: (root) => existsSync(join(root, '.serena', 'project.yml')),
    run: (root) => execSync(`serena project create --index "${root}"`, { stdio: 'inherit' }),
  },
  {
    id: 'semble',
    label: 'Semble (semantic code search index)',
    check: (_root) => false, // always offer re-index
    run: (root) => execSync(`semble --content code`, { cwd: root, stdio: 'inherit' }),
  },
];

export async function runInit({ yes = false, dir = process.cwd() } = {}) {
  const gitRoot = findGitRoot(dir);

  if (!gitRoot) {
    console.log(`\n⚠  Not inside a git repository (cwd: ${dir})\n`);
    return false;
  }

  const name = gitRoot.split(/[\\/]/).pop();
  console.log(`\n🧬 Myelin Init — ${name}`);
  console.log(`   Git root: ${gitRoot}\n`);

  let rl;
  if (!yes) {
    rl = createInterface({ input: process.stdin, output: process.stdout });
    const proceed = await confirm(rl, `   Initialize "${name}" with Myelin tools?`);
    if (!proceed) { rl.close(); console.log('   Cancelled.\n'); return false; }
  }

  const results = [];

  for (const tool of TOOLS) {
    const alreadyDone = tool.check(gitRoot);
    const label = alreadyDone ? `${tool.label} (already initialised — re-run?)` : tool.label;

    let run = yes;
    if (!yes) {
      run = await confirm(rl, `   Run: ${label}`, !alreadyDone);
    }

    if (run) {
      console.log(`   Running ${tool.id}...`);
      try {
        tool.run(gitRoot);
        console.log(`   ✓ ${tool.id} done`);
        results.push({ tool: tool.id, ok: true });
      } catch (e) {
        console.warn(`   ⚠ ${tool.id} failed: ${e.message.split('\n')[0]}`);
        results.push({ tool: tool.id, ok: false });
      }
    } else {
      console.log(`   · ${tool.id} skipped`);
    }
  }

  if (rl) rl.close();

  const ok = results.filter(r => r.ok).length;
  console.log(`\n   ✓ Init complete (${ok}/${results.length} tools ran).\n`);
  return true;
}
