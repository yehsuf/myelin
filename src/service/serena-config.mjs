import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Serena opens a browser tab/window every time its MCP server starts
 * (`web_dashboard_open_on_launch: true` is Serena's own documented
 * default). Flip it to false, in place, preserving every comment and the
 * rest of the file - Serena's config file is heavily hand-documented
 * (~90 lines of comments) and a full YAML parse+re-dump would blow all of
 * that away for a one-line change. Idempotent: a no-op if already false or
 * if the key isn't found at all (never invents new keys mid-file - if
 * Serena renames this setting in a future release, we simply do nothing
 * rather than corrupt the file).
 */
export function disableSerenaDashboardAutoOpen(yamlText) {
  return yamlText.replace(/^web_dashboard_open_on_launch:[ \t]*true[ \t]*$/m, 'web_dashboard_open_on_launch: false');
}

/** Cross-platform path to Serena's global config file. Same relative path
 * on every platform per Serena's own docs (~/.serena/serena_config.yml, or
 * %USERPROFILE%\.serena\serena_config.yml on Windows) - node's `homedir()`
 * already resolves to the right base directory on both. */
export function serenaConfigPath(home) {
  return join(home, '.serena', 'serena_config.yml');
}

/**
 * Patch the real file in place, if present. No-op (returns false) if the
 * file doesn't exist yet (Serena hasn't been run for the first time on
 * this machine) or if anything goes wrong reading/writing it - this is a
 * cosmetic quality-of-life tweak, never worth failing an install/init run
 * over. Safe to call from both `myelin install` (retroactively fixes an
 * existing config) and `myelin init` (catches a config freshly created by
 * that same init run's `serena project create` step).
 */
export function applyDisableSerenaDashboardAutoOpen(home) {
  const path = serenaConfigPath(home);
  try {
    if (!existsSync(path)) return false;
    const original = readFileSync(path, 'utf8');
    const patched = disableSerenaDashboardAutoOpen(original);
    if (patched === original) return false; // already false, or key not found - nothing to do
    writeFileSync(path, patched, 'utf8');
    return true;
  } catch {
    return false;
  }
}
