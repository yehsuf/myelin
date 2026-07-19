/**
 * `myelin fix` — self-healing fixes for platform-specific install issues.
 *
 * Currently supports:
 *   myelin fix headroom-win  — add Windows Defender exclusion for the myelin
 *                              components directory and retry headroom-original
 *                              installation (WIN-HEADROOM-FALLBACK-001).
 */
import { execSync, execFileSync } from 'node:child_process';
import { homedir } from 'node:os';

import { detectOS, powerShellExecutable } from '../detect/os.mjs';
import { managedPaths } from '../shared/myelin-paths.mjs';
import { COMPONENTS } from '../update/component-manifest.mjs';
import { stageComponent } from '../update/component-installers.mjs';
import { activateComponent } from '../update/version-store.mjs';
import { setConfigValue } from '../config/writer.mjs';
import { resolveInstallComponentStoragePlatform } from '../install.mjs';
import { isWsl } from '../detect/wsl.mjs';
import { updatePaths } from '../update/update-orchestrator.mjs';

/**
 * Adds a Windows Defender exclusion for the myelin components directory
 * (requires UAC elevation), then retries the headroom-original component
 * installation with --only-binary :all: (no Rust/MSVC required).
 *
 * If the install succeeds, switches config back to headroom-original and
 * prints instructions to run `myelin restart` to activate the new backend.
 */
export async function runFixHeadroomWin({
  home = homedir(),
  os = detectOS(),
  execSyncFn = execSync,
  execFileSyncFn = execFileSync,
  log = console.log,
  warn = console.warn,
} = {}) {
  if (os !== 'windows') {
    warn(`  ℹ myelin fix headroom-win is only needed on Windows (detected: ${os})`);
    return { status: 'skip', reason: 'not-windows' };
  }

  const paths = managedPaths({ home, platform: 'win32' });
  const componentsRoot = updatePaths(home).componentsRoot;
  const storagePlatform = resolveInstallComponentStoragePlatform(os, { isWslImpl: isWsl });
  const component = COMPONENTS.headroomOriginal;

  log('\n🔧 myelin fix headroom-win');
  log('─'.repeat(55));
  log(`  Components dir: ${componentsRoot}`);

  // Step 1: Add Windows Defender exclusion (requires elevation)
  log('\n[1/3] Adding Windows Defender exclusion...');
  log('  (A UAC elevation prompt will appear)');
  const ps = powerShellExecutable({ windowsInterop: false });
  // Encode the inner command as UTF-16LE base64 so -EncodedCommand eliminates
  // all quoting/escaping issues regardless of special chars in componentsRoot.
  // -PassThru + exit-code propagation ensures Node.js throws when UAC is
  // cancelled or the Defender cmdlet fails (Start-Process -Wait alone always
  // returns exit code 0 regardless of the child's outcome — Bug B from CR).
  const innerCmd = `Add-MpPreference -ExclusionPath '${componentsRoot.replace(/'/g, "''")}' -Force`;
  const encodedCmd = Buffer.from(innerCmd, 'utf16le').toString('base64');
  const outerScript = `$p = Start-Process powershell -Verb RunAs -Wait -PassThru -ArgumentList ('-EncodedCommand', '${encodedCmd}'); if ($p.ExitCode -ne 0) { exit $p.ExitCode }`;
  try {
    execSyncFn(`${ps} -NoProfile -NonInteractive -Command "${outerScript.replace(/"/g, '\\"')}"`, { stdio: 'inherit' });
    log('  ✓ Defender exclusion added');
  } catch (e) {
    warn(`  ✗ Failed to add Defender exclusion (UAC cancelled or policy blocked): ${e.message.split('\n')[0]}`);
    warn('  Manually add an exclusion in Windows Security → Virus & threat protection → Exclusions');
    warn(`  Path to exclude: ${componentsRoot}`);
    return { status: 'failed', step: 'defender' };
  }

  // Step 2: Retry headroom-original installation (--only-binary enforced by manifest)
  log('\n[2/3] Retrying headroom-original installation...');
  try {
    try {
      stageComponent({
        name: 'headroomOriginal',
        component,
        root: componentsRoot,
        platform: storagePlatform,
        exec: execFileSyncFn,
      });
    } catch (e) {
      if (e?.code !== 'ERR_COMPONENT_IMMUTABLE_STAGE_EXISTS') throw e;
      log('  · headroom-original already staged at this version');
    }
    await activateComponent({
      root: componentsRoot,
      name: 'headroomOriginal',
      version: component.version,
      platform: storagePlatform,
    });
    log('  ✓ headroom-original installed successfully');
  } catch (e) {
    warn(`  ✗ Installation still failed: ${e.message.split('\n')[0]}`);
    warn('  Verify the Defender exclusion is active and try again, or use headroom-lite:');
    warn('    myelin config set compression.backend headroom-lite && myelin restart');
    return { status: 'failed', step: 'install', error: e };
  }

  // Step 3: Switch config back to headroom-original
  log('\n[3/3] Switching config to headroom-original...');
  try {
    await setConfigValue('compression.backend', 'headroom-original');
    log('  ✓ Config updated: compression.backend = headroom-original');
  } catch (e) {
    warn(`  ⚠ Config update failed: ${e.message} — run manually:`);
    warn('    myelin config set compression.backend headroom-original');
  }

  log('\n✅ Done! Run: myelin restart   to activate headroom-original.\n');
  return { status: 'ok' };
}
