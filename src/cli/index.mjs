import { Command } from 'commander';
import { configCommand } from './config-cmd.mjs';

const program = new Command();
program.name('myelin').description('Myelin — the neural insulation layer for AI coding agents').version('1.0.0');

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
  .description('Update all Myelin tools')
  .option('--check', 'Show what would be updated without making changes')
  .action(async (opts) => {
    const { runUpdate } = await import('./update.mjs');
    await runUpdate({ check: opts.check });
  });

program.command('stats')
  .description('Show compression savings for Copilot and Claude Code')
  .action(async () => {
    const { runStats } = await import('./stats.mjs');
    await runStats();
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
  .description('Restart headroom and mitmproxy services')
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

program.parse();
