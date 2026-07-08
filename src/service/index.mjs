import { detectOS } from '../detect/os.mjs';

export async function installService(opts) {
  const os = detectOS();
  if (os === 'darwin') {
    const { installService } = await import('./launchd.mjs');
    return installService(opts);
  } else if (os === 'linux') {
    const { installService } = await import('./systemd.mjs');
    return installService(opts);
  } else {
    const { installService } = await import('./windows.mjs');
    return installService(opts);
  }
}

export async function installMitmService(opts) {
  const os = detectOS();
  if (os === 'darwin') {
    const { installMitmService } = await import('./launchd.mjs');
    return installMitmService(opts);
  } else if (os === 'linux') {
    const { installMitmService } = await import('./systemd.mjs');
    return installMitmService(opts);
  } else {
    const { installMitmService } = await import('./windows.mjs');
    return installMitmService(opts);
  }
}

/**
 * Install a watchdog that periodically revives dropped services.
 * macOS only for now — systemd's Restart=always + Linux's lack of the
 * silent crash-loop-disable behavior make it less critical there; Windows
 * has no equivalent yet (tracked separately).
 */
export async function installWatchdog(opts) {
  const os = detectOS();
  if (os === 'darwin') {
    const { installWatchdog } = await import('./launchd.mjs');
    return installWatchdog(opts);
  }
  return null;
}

/**
 * Install a SEPARATE, dedicated Headroom instance for Copilot CLI traffic
 * (opt-in via config.proxy.copilot_headroom.enabled). Distinct from
 * installService() above, which serves Claude Code.
 */
export async function installCopilotHeadroomService(opts) {
  const os = detectOS();
  if (os === 'darwin') {
    const { installCopilotHeadroomService } = await import('./launchd.mjs');
    return installCopilotHeadroomService(opts);
  } else if (os === 'linux') {
    const { installCopilotHeadroomService } = await import('./systemd.mjs');
    return installCopilotHeadroomService(opts);
  } else {
    const { installCopilotHeadroomService } = await import('./windows.mjs');
    return installCopilotHeadroomService(opts);
  }
}

export async function copilotHeadroomServiceStatus() {
  const os = detectOS();
  if (os === 'darwin') {
    const { copilotHeadroomServiceStatus } = await import('./launchd.mjs');
    return copilotHeadroomServiceStatus();
  } else if (os === 'linux') {
    const { copilotHeadroomServiceStatus } = await import('./systemd.mjs');
    return copilotHeadroomServiceStatus();
  } else {
    const { copilotHeadroomServiceStatus } = await import('./windows.mjs');
    return copilotHeadroomServiceStatus();
  }
}

export async function serviceStatus() {
  const os = detectOS();
  if (os === 'darwin') {
    const { serviceStatus } = await import('./launchd.mjs');
    return serviceStatus();
  } else if (os === 'linux') {
    const { serviceStatus } = await import('./systemd.mjs');
    return serviceStatus();
  } else {
    const { serviceStatus } = await import('./windows.mjs');
    return serviceStatus();
  }
}

export async function mitmServiceStatus() {
  const os = detectOS();
  if (os === 'darwin') {
    const { mitmServiceStatus } = await import('./launchd.mjs');
    return mitmServiceStatus();
  } else if (os === 'linux') {
    const { mitmServiceStatus } = await import('./systemd.mjs');
    return mitmServiceStatus();
  } else {
    const { mitmServiceStatus } = await import('./windows.mjs');
    return mitmServiceStatus();
  }
}
