import { writeFileSync, existsSync, copyFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { dump } from 'js-yaml';
import { loadConfig, readUserConfig, DEFAULT_CONFIG_PATH } from './reader.mjs';

export async function writeConfig(config, configPath = DEFAULT_CONFIG_PATH) {
  mkdirSync(dirname(configPath), { recursive: true });
  if (existsSync(configPath)) {
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    copyFileSync(configPath, `${configPath}.bak.${ts}`);
  }
  writeFileSync(configPath, dump(config, { lineWidth: 120 }), 'utf8');
}

export async function setConfigValue(dotPath, value, configPath = DEFAULT_CONFIG_PATH) {
  // Read the raw user-supplied config (without normalization/derivation) so
  // that writing it back never "bakes in" derived fields (e.g. compression.backend)
  // that would create circular overrides and prevent subsequent config-set calls
  // from taking effect. loadConfig is still used for display/read paths; only
  // the write path uses the raw form.
  const current = readUserConfig(configPath);
  const keys = dotPath.split('.');
  let node = current;
  for (let i = 0; i < keys.length - 1; i++) {
    if (typeof node[keys[i]] !== 'object' || node[keys[i]] === null) node[keys[i]] = {};
    node = node[keys[i]];
  }
  const raw = value;
  node[keys[keys.length - 1]] = isNaN(raw) ? (raw === 'true' ? true : raw === 'false' ? false : raw) : Number(raw);
  await writeConfig(current, configPath);
}

export async function getConfigValue(dotPath, configPath = DEFAULT_CONFIG_PATH) {
  const cfg = await loadConfig(configPath);
  return dotPath.split('.').reduce((o, k) => (o != null ? o[k] : undefined), cfg);
}
