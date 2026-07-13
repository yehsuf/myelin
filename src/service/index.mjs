import { detectOS } from '../detect/os.mjs';

export async function installEngineInstance(instance, platformOptions = {}) {
  const os = detectOS();
  if (os === 'darwin') {
    const service = await import('./launchd.mjs');
    return service.installEngineInstance(instance, platformOptions);
  }
  if (os === 'linux') {
    const service = await import('./systemd.mjs');
    return service.installEngineInstance(instance, platformOptions);
  }
  const service = await import('./windows.mjs');
  return service.installEngineInstance(instance, platformOptions);
}

export async function engineInstanceStatus(instance, platformOptions = {}) {
  const os = detectOS();
  if (os === 'darwin') {
    const service = await import('./launchd.mjs');
    return service.engineInstanceStatus(instance, platformOptions);
  }
  if (os === 'linux') {
    const service = await import('./systemd.mjs');
    return service.engineInstanceStatus(instance, platformOptions);
  }
  const service = await import('./windows.mjs');
  return service.engineInstanceStatus(instance, platformOptions);
}

export async function removeEngineInstance(instance, platformOptions = {}) {
  const os = detectOS();
  if (os === 'darwin') {
    const service = await import('./launchd.mjs');
    return service.removeEngineInstance(instance, platformOptions);
  }
  if (os === 'linux') {
    const service = await import('./systemd.mjs');
    return service.removeEngineInstance(instance, platformOptions);
  }
  const service = await import('./windows.mjs');
  return service.removeEngineInstance(instance, platformOptions);
}

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
 * Install a watchdog that periodically revives dropped or hung services.
 * macOS always gets the launchd watchdog; Windows can opt into a Scheduled
 * Task liveness check because WinSW only sees process exits, not /health
 * stalls. Linux still returns null for now.
 */
export async function installWatchdog(opts) {
  const os = detectOS();
  if (os === 'darwin') {
    const { installWatchdog } = await import('./launchd.mjs');
    return installWatchdog(opts);
  }
  if (os === 'windows') {
    const { installWatchdog } = await import('./windows.mjs');
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

export async function copilotHeadroomServiceStatus(opts) {
  const os = detectOS();
  if (os === 'darwin') {
    const { copilotHeadroomServiceStatus } = await import('./launchd.mjs');
    return copilotHeadroomServiceStatus(opts);
  } else if (os === 'linux') {
    const { copilotHeadroomServiceStatus } = await import('./systemd.mjs');
    return copilotHeadroomServiceStatus(opts);
  } else {
    const { copilotHeadroomServiceStatus } = await import('./windows.mjs');
    return copilotHeadroomServiceStatus(opts);
  }
}

export async function serviceStatus(opts) {
  const os = detectOS();
  if (os === 'darwin') {
    const { serviceStatus } = await import('./launchd.mjs');
    return serviceStatus(opts);
  } else if (os === 'linux') {
    const { serviceStatus } = await import('./systemd.mjs');
    return serviceStatus(opts);
  } else {
    const { serviceStatus } = await import('./windows.mjs');
    return serviceStatus(opts);
  }
}

export async function mitmServiceStatus(opts) {
  const os = detectOS();
  if (os === 'darwin') {
    const { mitmServiceStatus } = await import('./launchd.mjs');
    return mitmServiceStatus(opts);
  } else if (os === 'linux') {
    const { mitmServiceStatus } = await import('./systemd.mjs');
    return mitmServiceStatus(opts);
  } else {
    const { mitmServiceStatus } = await import('./windows.mjs');
    return mitmServiceStatus(opts);
  }
}
