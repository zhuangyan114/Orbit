import * as vscode from 'vscode';

export const ORBIT_CONFIGURATION_SECTION = 'orbit';
export const LEGACY_ORBIT_CONFIGURATION_SECTION = 'ozone';

// These are the user-facing settings that moved from ozone.* to orbit.*.
// Runtime identifiers such as the ozone DAP type and ozone.* API methods are
// intentionally not part of this list.
export const ORBIT_SETTING_KEYS = [
  'jlinkPath',
  'jlinkDllPath',
  'defaultDevice',
  'defaultInterface',
  'defaultSpeed',
  'defaultProgram',
  'defaultSvdFile',
  'defaultRtos',
  'rtosViewsAutoRefresh',
  'rttLogEnabled',
  'rttTimelineEnabled',
  'rttTimelineChannelIndex',
  'logging.enabled',
  'logging.clearOnStart',
  'rttBufferIndex',
  'rttPollIntervalMs',
  'rttReadSize',
  'rttControlBlockAddress',
  'rttStripAnsi',
  'rttLogTarget',
  'pRtLogEnabled',
  'pRtLogRoot',
  'nativeDebugEngine.enabled',
  'nativeDebugEngine.mode',
  'watchPollIntervalMs',
  'timelineSampleIntervalMs',
  'timelineSendIntervalMs',
  'timelineDataSource',
  'flashBeforeDebug',
  'recentSessions',
] as const;

export function getOrbitConfiguration(section?: string): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration(section ? `${ORBIT_CONFIGURATION_SECTION}.${section}` : ORBIT_CONFIGURATION_SECTION);
}

/**
 * Copy explicitly configured legacy values to the new Orbit namespace while
 * preserving the original target scope. This runs once per activation and is
 * safe to call again because an existing orbit.* value wins.
 */
export async function migrateLegacyOrbitSettings(): Promise<void> {
  const orbit = getOrbitConfiguration();
  const legacy = vscode.workspace.getConfiguration(LEGACY_ORBIT_CONFIGURATION_SECTION);
  const scopes: Array<{
    inspectionKey: 'workspaceFolderValue' | 'workspaceValue' | 'globalValue';
    target: vscode.ConfigurationTarget;
  }> = [
    { inspectionKey: 'workspaceFolderValue', target: vscode.ConfigurationTarget.WorkspaceFolder },
    { inspectionKey: 'workspaceValue', target: vscode.ConfigurationTarget.Workspace },
    { inspectionKey: 'globalValue', target: vscode.ConfigurationTarget.Global },
  ];

  for (const key of ORBIT_SETTING_KEYS) {
    const orbitInspection = orbit.inspect(key);
    const legacyInspection = legacy.inspect(key);
    if (!legacyInspection) continue;

    for (const { inspectionKey, target } of scopes) {
      const orbitValue = (orbitInspection as any)?.[inspectionKey];
      const legacyValue = (legacyInspection as any)?.[inspectionKey];
      if (orbitValue === undefined && legacyValue !== undefined) {
        await orbit.update(key, legacyValue, target);
      }
    }
  }
}
