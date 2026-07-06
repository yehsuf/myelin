import { readFileSync, existsSync } from 'node:fs';
import { load as parse } from 'js-yaml';
import { DEFAULT_CONFIG, mergeDeep } from './schema.mjs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const DEFAULT_CONFIG_PATH = join(homedir(), '.tokenstack', 'config.yaml');

export async function loadConfig(configPath = DEFAULT_CONFIG_PATH) {
  let userConfig = {};
  if (existsSync(configPath)) {
    try {
      userConfig = parse(readFileSync(configPath, 'utf8')) ?? {};
    } catch (e) {
      console.warn(`[tokenstack] Warning: Could not parse config at ${configPath}: ${e.message}`);
    }
  }
  let merged = mergeDeep(DEFAULT_CONFIG, userConfig);

  // Env var overrides (highest priority)
  if (process.env.HEADROOM_PORT) {
    const rawPort = parseInt(process.env.HEADROOM_PORT, 10);
    if (!Number.isNaN(rawPort)) {
      merged = mergeDeep(merged, { proxy: { headroom: { port: rawPort } } });
    } else {
      console.warn(`[tokenstack] Warning: HEADROOM_PORT="${process.env.HEADROOM_PORT}" is not a valid integer, ignoring.`);
    }
  }
  if (process.env.TOKENSTACK_PROFILE) {
    merged._profile = process.env.TOKENSTACK_PROFILE;
  }
  if (process.env.TOKENSTACK_INDEX_TIER) {
    merged.index_tier = process.env.TOKENSTACK_INDEX_TIER;
  }

  return merged;
}
