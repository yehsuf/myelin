import { execSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const INSTALL_MJS  = join(dirname(__filename), '..', 'install.mjs');

/**
 * Resolve the repo root from any path inside the working tree.
 * Pure — returns null when not in a git repo.
 */
export function repoRoot(cwd = process.cwd(), execSyncFn = execSync) {
  try {
    return execSyncFn('git rev-parse --show-toplevel', { cwd, stdio: 'pipe' })
      .toString().trim();
  } catch { return null; }
}

/**
 * Derive a canonical sibling directory for a new worktree.
 * e.g. ~/tokenstack + feat/auth-fix → ~/tokenstack-wt-feat-auth-fix
 */
export function worktreeDir(root, branch) {
  const safe = branch.replace(/[^a-zA-Z0-9._-]/g, '-').replace(/-{2,}/g, '-').replace(/^-|-$/g, '');
  return join(dirname(root), `${basename(root)}-wt-${safe}`);
}

/**
 * Return SSH commands to run `npm test` on the branch across all three platforms.
 * Pure — used in both the CLI output and CLAUDE.md.
 */
export function crossPlatformTestCmds(branch, { winHost = 'yeh-legion', linuxHost = 'muc-lhvsuz' } = {}) {
  const fetch = `git fetch origin && git checkout ${branch} && npm test`;
  return {
    windows: `ssh ${winHost} "cd %USERPROFILE%\\.myelin\\repo && ${fetch}"`,
    linux:   `ssh ${linuxHost} 'cd ~/.myelin/repo && ${fetch}'`,
  };
}

export async function runWorktreeAdd(branch, opts = {}, deps = {}) {
  const exec    = deps.execSync   ?? execSync;
  const log     = deps.log        ?? console.log;
  const warn    = deps.warn       ?? console.warn;
  const spawn   = deps.spawnSync  ?? spawnSync;
  const exists  = deps.existsSync ?? existsSync;

  const root = repoRoot(process.cwd(), exec);
  if (!root) { warn('  ✗ Not inside a git repository.'); return { ok: false }; }

  const dir = opts.dir ?? worktreeDir(root, branch);

  log(`\n🌿 Myelin Worktree — add\n${'─'.repeat(50)}`);
  log(`  branch: ${branch}`);
  log(`  path:   ${dir}`);

  // 1. Create the worktree + branch
  if (exists(dir)) {
    warn(`  ⚠ Directory already exists: ${dir}`);
  } else {
    try {
      exec(`git worktree add "${dir}" -b "${branch}"`, { cwd: root, stdio: 'pipe' });
      log('  ✓ git worktree created');
    } catch (e) {
      // Branch may already exist — try checking it out
      try {
        exec(`git worktree add "${dir}" "${branch}"`, { cwd: root, stdio: 'pipe' });
        log('  ✓ git worktree created (existing branch)');
      } catch (e2) {
        warn(`  ✗ git worktree add failed: ${e2.message.split('\n')[0]}`);
        return { ok: false };
      }
    }
  }

  // 2. Register with Serena + write Copilot/Claude Code hooks via myelin init
  log('  → Running myelin init (registers with Serena + writes session hooks)...');
  const initResult = spawn(process.execPath, [INSTALL_MJS.replace('install.mjs', 'cli/index.mjs'), 'init', '--yes'], {
    cwd: dir,
    stdio: 'inherit',
  });
  if (initResult.status === 0) {
    log('  ✓ Registered with Serena + Copilot/Claude Code hooks written');
  } else {
    warn('  ⚠ myelin init had warnings — run manually: myelin init --yes');
  }

  // 3. Print next steps
  const cmds = crossPlatformTestCmds(branch);
  log(`\n${'─'.repeat(50)}`);
  log(`  ✓ Worktree ready. Next steps:\n`);
  log(`  cd "${dir}"`);
  log(`  # ... make changes, then test on all 3 platforms:\n`);
  log(`  npm test                          # Mac (local)`);
  log(`  ${cmds.windows}`);
  log(`  ${cmds.linux}`);
  log(`\n  # Merge + cleanup:`);
  log(`  myelin worktree remove ${branch}  # removes worktree + branch`);
  log('');

  return { ok: true, dir, branch };
}

export async function runWorktreeRemove(branch, opts = {}, deps = {}) {
  const exec  = deps.execSync ?? execSync;
  const log   = deps.log      ?? console.log;
  const warn  = deps.warn     ?? console.warn;

  const root = repoRoot(process.cwd(), exec);
  if (!root) { warn('  ✗ Not inside a git repository.'); return { ok: false }; }

  const dir = opts.dir ?? worktreeDir(root, branch);

  log(`\n🌿 Myelin Worktree — remove\n${'─'.repeat(50)}`);
  log(`  branch: ${branch}`);
  log(`  path:   ${dir}`);

  // 1. Remove worktree (--force handles unclean trees)
  try {
    exec(`git worktree remove --force "${dir}"`, { cwd: root, stdio: 'pipe' });
    log('  ✓ git worktree removed');
  } catch (e) {
    warn(`  ⚠ git worktree remove failed: ${e.message.split('\n')[0]}`);
    warn('    Try manually: git worktree prune');
  }

  // 2. Delete the local branch
  if (!opts.keepBranch) {
    try {
      exec(`git branch -d "${branch}"`, { cwd: root, stdio: 'pipe' });
      log(`  ✓ branch "${branch}" deleted`);
    } catch {
      try {
        exec(`git branch -D "${branch}"`, { cwd: root, stdio: 'pipe' });
        log(`  ✓ branch "${branch}" force-deleted (had unmerged commits)`);
      } catch (e2) {
        warn(`  ⚠ could not delete branch: ${e2.message.split('\n')[0]}`);
      }
    }
  }

  log('');
  return { ok: true };
}
