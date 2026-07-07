import { Command } from 'commander';
import { loadConfig, DEFAULT_CONFIG_PATH } from '../config/reader.mjs';
import { setConfigValue, getConfigValue, writeConfig } from '../config/writer.mjs';
import { DEFAULT_CONFIG } from '../config/schema.mjs';
import { dump } from 'js-yaml';
import { execSync } from 'node:child_process';
import { copyFileSync, existsSync } from 'node:fs';

export function configCommand() {
  const cmd = new Command('config').description('Manage Myelin configuration');

  cmd.command('show')
    .description('Print current configuration (merged with defaults)')
    .option('--path <key>', 'Show only a specific key (dot-notation)')
    .action(async ({ path }) => {
      const cfg = await loadConfig();
      if (path) {
        const val = await getConfigValue(path);
        console.log(val !== undefined ? JSON.stringify(val, null, 2) : '(not set — default applies)');
      } else {
        console.log(dump(cfg, { lineWidth: 120 }));
      }
    });

  cmd.command('set <key> <value>')
    .description('Set a configuration value (dot-notation key)')
    .action(async (key, value) => {
      await setConfigValue(key, value);
      console.log(`✓ Set ${key} = ${value}`);
      if (key === 'proxy.headroom.port') {
        console.log('  ↳ Port change detected — run: myelin verify to check the new port');
      }
    });

  cmd.command('get <key>')
    .description('Get a single configuration value')
    .action(async (key) => {
      const val = await getConfigValue(key);
      console.log(val !== undefined ? val : '(not set)');
    });

  cmd.command('reset')
    .description('Reset configuration to defaults (backs up current config)')
    .action(async () => {
      if (existsSync(DEFAULT_CONFIG_PATH)) {
        const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        copyFileSync(DEFAULT_CONFIG_PATH, `${DEFAULT_CONFIG_PATH}.bak.${ts}`);
        console.log('✓ Backed up existing config');
      }
      await writeConfig(DEFAULT_CONFIG);
      console.log(`✓ Configuration reset to defaults at ${DEFAULT_CONFIG_PATH}`);
    });

  cmd.command('edit')
    .description('Open configuration in $EDITOR')
    .action(() => {
      const editor = process.env.EDITOR ?? (process.platform === 'win32' ? 'notepad' : 'nano');
      try { execSync(`${editor} ${DEFAULT_CONFIG_PATH}`, { stdio: 'inherit' }); }
      catch (e) { console.error(`Could not open editor: ${e.message}`); process.exit(1); }
    });

  return cmd;
}
