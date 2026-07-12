export function selectedEngine(config = {}) {
  return config?.proxy?.engine === 'headroom_lite' ? 'headroom_lite' : 'headroom';
}

export function selectedEnginePort(config = {}) {
  return selectedEngine(config) === 'headroom_lite'
    ? (config?.proxy?.headroom_lite?.port ?? 8790)
    : (config?.proxy?.headroom?.port ?? 8787);
}

export function buildServiceEnginePlan(config = {}) {
  const engine = selectedEngine(config);
  const headroomPort = config?.proxy?.headroom?.port ?? 8787;
  const headroomLitePort = config?.proxy?.headroom_lite?.port ?? 8790;

  return {
    selectedEngine: engine,
    selectedPort: engine === 'headroom_lite' ? headroomLitePort : headroomPort,
    headroomPort,
    headroomLitePort,
    shouldRunManagedHeadroom: engine === 'headroom',
    shouldRemoveManagedHeadroom: engine !== 'headroom',
  };
}
