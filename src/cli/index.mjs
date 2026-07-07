import { Command } from 'commander';
import { configCommand } from './config-cmd.mjs';

const program = new Command();
program.name('tokenstack').description('Myelin — the neural insulation layer for AI coding agents').version('1.0.0');

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
  .description('Update all TokenStack tools')
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

program.parse();
