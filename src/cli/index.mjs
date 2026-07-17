import { Command } from 'commander';
import { configCommand } from './config-cmd.mjs';
import { resolveCliVersion } from './cli-version.mjs';

const program = new Command();
program.name('myelin').description('Myelin — the neural insulation layer for AI coding agents').version(resolveCliVersion());

program.addCommand(configCommand());

program.command('verify')
  .description('Verify all components are healthy')
  .action(async () => {
    const { runVerify } = await import('./verify.mjs');
    const ok = await runVerify();
    process.exit(ok ? 0 : 1);
  });

program.command('diagnose')
  .description('Diagnose port conflicts and configuration issues')
  .action(async () => {
    const { runDiagnose } = await import('./diagnose.mjs');
    await runDiagnose();
  });

program.command('update')
  .description('Update Myelin as one pinned release')
  .option('--check', 'Show release and component drift without making changes')
  .option('--download-only', 'Stage and validate the latest release without activating it')
  .option('--channel <channel>', 'Release channel: stable or main', 'main')
  .option('--self', 'Removed; use myelin update')
  .option('-f, --force', 'Removed; use myelin update')
  .action(async (opts) => {
    if (opts.self) {
      console.error('Error: --self was removed. Use `myelin update` or `myelin update --channel main`.');
      process.exitCode = 2;
      return;
    }
    if (opts.force) {
      console.error('Error: --force was removed. Use `myelin update` or `myelin update --channel main`.');
      process.exitCode = 2;
      return;
    }
    if (!['stable', 'main'].includes(opts.channel)) {
      console.error('Error: invalid update channel. Choose stable or main.');
      process.exitCode = 2;
      return;
    }
    const { runUpdate: runAtomicUpdate } = await import('./update.mjs');
    let result;
    try {
      result = await runAtomicUpdate({
        channel: opts.channel,
        check: opts.check,
        downloadOnly: opts.downloadOnly,
      });
    } catch (error) {
      console.error(`Update failed: ${error?.message ?? error}`);
      process.exitCode = 1;
      return;
    }
    if (!result.ok) {
      console.error(`Update failed: ${result.error?.message ?? result.status}`);
    }
    process.exitCode = result.ok ? 0 : 1;
  });

program.command('self')
  .description('Manage the Myelin runtime')
  .command('update')
  .description('Deprecated: use `myelin update`')
  .action(async () => {
    const { runDeprecatedNestedSelfUpdate } = await import('./update.mjs');
    const result = runDeprecatedNestedSelfUpdate();
    process.exit(result.exitCode);
  });

program.command('stats')
  .description('Show compression savings for Copilot and Claude Code')
  .option('--wide', 'Show wide stats output')
  .action(async (opts) => {
    const { runStats } = await import('./stats.mjs');
    await runStats({ wide: opts.wide });
  });

program.command('init')
  .description('Initialize current git repo with Serena + Semble (register + index)')
  .option('-y, --yes', 'Auto-accept all prompts')
  .option('-r, --recursive', 'Find and init all git repos under current directory')
  .option('-d, --depth <n>', 'Max search depth for --recursive', '4')
  .action(async (opts) => {
    const { runInit } = await import('./init.mjs');
    await runInit({ yes: opts.yes, recursive: opts.recursive, depth: parseInt(opts.depth) });
  });

program.command('restart')
  .description('Restart the selected engine (headroom or headroom-lite) and mitmproxy services')
  .action(async () => {
    const { runRestart } = await import('./restart.mjs');
    await runRestart();
  });

program.command('reload')
  .description('Reload shell profiles in all open terminal windows')
  .action(async () => {
    const { runReload } = await import('./reload.mjs');
    await runReload();
  });

program.command('install')
  .description('Install or update all Myelin components')
  .option('-y, --yes', 'Auto-accept all prompts')
  .option('--profile <profile>', 'Installation profile (proxy|mcp|minimal)', 'proxy')
  .option('--dry-run', 'Show what would be installed without making changes')
  .option('--no-headroom', 'Skip headroom install')
  .option('--no-rtk', 'Skip RTK install')
  .option('--copilot-only', 'Configure Copilot only (skip Claude Code)')
  .option('--claude-only', 'Configure Claude Code only (skip Copilot)')
  .action(async (opts) => {
    const { spawnSync } = await import('node:child_process');
    const { fileURLToPath } = await import('node:url');
    const { join: pjoin, dirname } = await import('node:path');
    const installPath = pjoin(dirname(fileURLToPath(import.meta.url)), '..', 'install.mjs');
    const args = [installPath];
    if (opts.yes)         args.push('--yes');
    if (opts.dryRun)      args.push('--dry-run');
    if (opts.profile !== 'proxy') args.push('--profile', opts.profile);
    if (opts.noHeadroom)  args.push('--no-headroom');
    if (opts.noRtk)       args.push('--no-rtk');
    if (opts.copilotOnly) args.push('--copilot-only');
    if (opts.claudeOnly)  args.push('--claude-only');
    const result = spawnSync(process.execPath, args, { stdio: 'inherit' });
    process.exit(result.status ?? 0);
  });

program.command('compact')
  .description('Prepare a /compact hint from live session state, or re-orient after /compact')
  .argument('[mode]', 'prepare | emit | resume (default: prepare)')
  .action(async (mode = 'prepare') => {
    const { spawnSync } = await import('node:child_process');
    const { fileURLToPath } = await import('node:url');
    const { join: pjoin, dirname } = await import('node:path');
    const script = pjoin(dirname(fileURLToPath(import.meta.url)), 'compact-prepare.mjs');
    const r = spawnSync(process.execPath, [script, mode], { stdio: 'inherit' });
    process.exit(r.status ?? 0);
  });

program.command('constitution')
  .description('Manage project constitution (.github/copilot-instructions.md)')
  .argument('<cmd>', 'init | show | check | append | lock')
  .argument('[args...]', 'For append: <section> <bullet>')
  .option('--repo <path>', 'Override repo root')
  .option('--force', 'Force append even on near-duplicate bullet')
  .action(async (cmd, args, opts) => {
    const { cmdInit, cmdShow, cmdCheck, cmdAppend, cmdLock } = await import('./constitution.mjs');
    let code = 0;
    switch (cmd) {
      case 'init':   code = cmdInit({ repo: opts.repo }); break;
      case 'show':   code = cmdShow({ repo: opts.repo }); break;
      case 'check':  code = cmdCheck({ repo: opts.repo }); break;
      case 'append': code = cmdAppend(args[0], args[1], { repo: opts.repo, force: opts.force }); break;
      case 'lock':   code = cmdLock({ repo: opts.repo }); break;
      default:
        console.error(`Unknown constitution subcommand: ${cmd}. Use init|show|check|append|lock`);
        code = 1;
    }
    process.exit(code ?? 0);
  });

program.command('serena-guard')
  .description('[internal] Serena hook bridge for Copilot CLI / Claude Code - wired per-project by `myelin init`')
  .requiredOption('--event <event>', 'hook event name: preToolUse, preToolUseAutoApprove, sessionStart, or stop')
  .option('--target <target>', 'output shape: copilot-cli (flat, unwrapped) or claude-code (native passthrough)', 'copilot-cli')
  .action(async (opts) => {
    const { runServenaGuardCli } = await import('./serena-guard.mjs');
    runServenaGuardCli(opts.event, opts.target);
  });

program.command('rtk-guard')
  .description('[internal] fail-open RTK shell-compression hook bridge for Copilot CLI — wired globally by `myelin install`; never denies a tool call')
  .argument('[target]', 'rtk hook target (copilot|claude|cursor|gemini)', 'copilot')
  .action(async (target) => {
    const { runRtkGuardCli } = await import('./rtk-guard.mjs');
    runRtkGuardCli(target);
  });

program.parse();
