import { readFileSync, existsSync } from 'node:fs';
import { load as parse } from 'js-yaml';
import { DEFAULT_CONFIG, mergeDeep } from './schema.mjs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const DEFAULT_CONFIG_PATH = join(homedir(), '.myelin', 'config.yaml');

export function readUserConfig(configPath = DEFAULT_CONFIG_PATH, warn = console.warn) {
  let userConfig = {};
  if (existsSync(configPath)) {
    try {
      userConfig = parse(readFileSync(configPath, 'utf8')) ?? {};
    } catch (e) {
      warn(`[myelin] Warning: Could not parse config at ${configPath}: ${e.message}`);
    }
  }
  return userConfig;
}

export async function loadConfig(configPath = DEFAULT_CONFIG_PATH) {
  const userConfig = readUserConfig(configPath);
  let merged = mergeDeep(DEFAULT_CONFIG, userConfig);

  // Env var overrides (highest priority)
  if (process.env.HEADROOM_PORT) {
    const rawPort = parseInt(process.env.HEADROOM_PORT, 10);
    if (!Number.isNaN(rawPort)) {
      merged = mergeDeep(merged, { proxy: { headroom: { port: rawPort } } });
    } else {
      console.warn(`[myelin] Warning: HEADROOM_PORT="${process.env.HEADROOM_PORT}" is not a valid integer, ignoring.`);
    }
  }
  if (process.env.MYELIN_PROFILE) {
    merged._profile = process.env.MYELIN_PROFILE;
  }
  if (process.env.MYELIN_INDEX_TIER) {
    merged.index_tier = process.env.MYELIN_INDEX_TIER;
  }

  return merged;
}
