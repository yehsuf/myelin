import { Command } from 'commander';
import { loadConfig, readUserConfig, DEFAULT_CONFIG_PATH } from '../config/reader.mjs';
import { setConfigValue, getConfigValue, writeConfig } from '../config/writer.mjs';
import { DEFAULT_CONFIG, pruneUnknownKeys, listUnknownKeyPaths } from '../config/schema.mjs';
import { dump } from 'js-yaml';
import { execSync } from 'node:child_process';
import { copyFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';

export function defaultConfigEditor(platform = process.platform) {
  return platform === 'win32' ? 'notepad' : 'nano';
}

export function configEditorName(platform = process.platform, editorOverride = process.env.EDITOR) {
  return editorOverride ?? defaultConfigEditor(platform);
}

export function platformConfigBanner(
  platform = process.platform,
  configPath = DEFAULT_CONFIG_PATH,
  editor = defaultConfigEditor(platform),
) {
  return `Config: ${configPath} — edit: myelin config edit (${editor}) — syntax: myelin config --help`;
}

function displayConfigPath(configPath = DEFAULT_CONFIG_PATH, homeDir = homedir()) {
  return configPath.startsWith(homeDir) ? `~${configPath.slice(homeDir.length)}` : configPath;
}

export async function pruneConfig({
  configPath = DEFAULT_CONFIG_PATH,
  dryRun = false,
  log = console.log,
  readUserConfigFn = readUserConfig,
  writeConfigFn = writeConfig,
  schema = DEFAULT_CONFIG,
} = {}) {
  const rawUserConfig = await readUserConfigFn(configPath);
  const prunedConfig = pruneUnknownKeys(rawUserConfig, schema);
  const staleKeys = listUnknownKeyPaths(rawUserConfig, schema);
  const shownPath = displayConfigPath(configPath);

  if (staleKeys.length === 0) {
    log('✓ No stale config keys found.');
    return { changed: false, dryRun, staleKeys, configPath: shownPath };
  }

  log('Stale config keys to remove:');
  staleKeys.forEach((key) => log(`  - ${key}`));

  if (dryRun) {
    log(`✓ Dry run: ${staleKeys.length} stale key(s) would be removed from ${shownPath}.`);
    return { changed: false, dryRun: true, staleKeys, configPath: shownPath };
  }

  await writeConfigFn(prunedConfig, configPath);
  log(`✓ Pruned ${staleKeys.length} stale key(s) from ${shownPath} (backup saved).`);
  return { changed: true, dryRun: false, staleKeys, configPath: shownPath };
}

export function configCommand() {
  const cmd = new Command('config').description('Manage Myelin configuration');
  cmd.addHelpText('before', () => `${platformConfigBanner()}\n\n`);

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

  cmd.command('prune')
    .description('Remove stale keys no longer present in the config schema')
    .option('--dry-run', 'Preview stale keys without rewriting config')
    .action(async ({ dryRun }) => {
      await pruneConfig({ dryRun });
    });

  cmd.command('edit')
    .description('Open configuration in $EDITOR')
    .action(() => {
      const editor = configEditorName();
      try { execSync(`${editor} ${DEFAULT_CONFIG_PATH}`, { stdio: 'inherit' }); }
      catch (e) { console.error(`Could not open editor: ${e.message}`); process.exit(1); }
    });

  return cmd;
}
