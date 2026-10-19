import {
  CmsisDapTransport,
  DebugProbePreference,
} from '../ozone-backend/types';

export interface NormalizedDapLaunchConfig {
  rmlinkDeviceId?: string;
  probe: DebugProbePreference;
  cmsisDapTransport: CmsisDapTransport;
  cmsisDapSerial?: string;
  cmsisDapVid?: string;
  cmsisDapPid?: string;
  cmsisDapPath?: string;
  cmsisDapFlashAlgorithmPath?: string;
  cmsisDapXrSampling?: boolean;
  flashBeforeDebug: boolean;
  runToEntryPoint?: string | false;
}

export class DapLaunchConfigError extends Error {
  readonly errorCode = 'InvalidConfiguration' as const;

  constructor(
    readonly field: 'probe' | 'cmsisDapTransport' | 'rmlinkDeviceId' | 'cmsisDapXrSampling',
    value: unknown,
  ) {
    const received = typeof value === 'string' ? `"${value}"` : String(value);
    const allowed = field === 'rmlinkDeviceId' ? 'a 12-digit RMLink device ID' : field === 'probe'
      ? 'auto, jlink, cmsis-dap, or rmlink'
      : 'auto, cmsis-dap-v2, cmsis-dap, hid, winusb, or tcp';
    super(field === 'cmsisDapXrSampling'
      ? `InvalidConfiguration: ${field} must be a boolean; received ${received}`
      : `InvalidConfiguration: ${field} must be one of ${allowed}; received ${received}`);
    this.name = 'DapLaunchConfigError';
    Object.setPrototypeOf(this, DapLaunchConfigError.prototype);
  }
}

export function normalizeDapLaunchConfig(input: unknown): NormalizedDapLaunchConfig {
  const args = input && typeof input === 'object'
    ? input as Record<string, unknown>
    : {};
  if (args.probe !== undefined && args.probe !== 'auto' && args.probe !== 'jlink' && args.probe !== 'cmsis-dap' && args.probe !== 'rmlink') {
    throw new DapLaunchConfigError('probe', args.probe);
  }
  if (args.cmsisDapTransport !== undefined
    && args.cmsisDapTransport !== 'auto'
    && args.cmsisDapTransport !== 'cmsis-dap-v2'
    && args.cmsisDapTransport !== 'cmsis-dap'
    && args.cmsisDapTransport !== 'hid'
    && args.cmsisDapTransport !== 'winusb'
    && args.cmsisDapTransport !== 'tcp') {
    throw new DapLaunchConfigError('cmsisDapTransport', args.cmsisDapTransport);
  }
  if (args.cmsisDapXrSampling !== undefined && typeof args.cmsisDapXrSampling !== 'boolean') {
    throw new DapLaunchConfigError('cmsisDapXrSampling', args.cmsisDapXrSampling);
  }
  const config: NormalizedDapLaunchConfig = {
    probe: args.probe === 'jlink' || args.probe === 'cmsis-dap' || args.probe === 'rmlink' ? args.probe : 'auto',
    cmsisDapTransport: args.cmsisDapTransport === undefined ? 'auto' : args.cmsisDapTransport,
    flashBeforeDebug: args.flashBeforeDebug !== false,
  };
  if(args.rmlinkDeviceId!==undefined) {
    if(typeof args.rmlinkDeviceId!=='string' || !/^[0-9a-fA-F]{12}$/.test(args.rmlinkDeviceId))throw new DapLaunchConfigError('rmlinkDeviceId',args.rmlinkDeviceId);
    if(args.probe==='jlink')throw new DapLaunchConfigError('probe',args.probe);
    config.rmlinkDeviceId=args.rmlinkDeviceId.toLowerCase();config.probe='rmlink';
    // Keep the original ID-only opt-in compatible. Explicit RMLink launches
    // follow the normal F5 Flash default.
    if(args.probe!=='rmlink' && args.flashBeforeDebug===undefined)config.flashBeforeDebug=false;
  }
  if (typeof args.cmsisDapXrSampling === 'boolean') config.cmsisDapXrSampling = args.cmsisDapXrSampling;

  if (config.probe === 'cmsis-dap' || config.probe === 'rmlink') {
    const entry = typeof args.runToEntryPoint === 'string' ? args.runToEntryPoint.trim() : '';
    config.runToEntryPoint = args.runToEntryPoint === false ? false : entry || 'main';
  }

  for (const field of ['cmsisDapSerial', 'cmsisDapVid', 'cmsisDapPid', 'cmsisDapPath', 'cmsisDapFlashAlgorithmPath'] as const) {
    const value = typeof args[field] === 'string' ? args[field].trim() : '';
    if (value) config[field] = value;
  }
  return config;
}

export function applyNormalizedDapLaunchConfig(
  config: Record<string, unknown>,
  targetConfig: NormalizedDapLaunchConfig,
): void {
  config.probe = targetConfig.probe;
  config.rmlinkDeviceId=targetConfig.rmlinkDeviceId;
  config.cmsisDapTransport = targetConfig.cmsisDapTransport;
  config.cmsisDapSerial = targetConfig.cmsisDapSerial;
  config.cmsisDapVid = targetConfig.cmsisDapVid;
  config.cmsisDapPid = targetConfig.cmsisDapPid;
  config.cmsisDapPath = targetConfig.cmsisDapPath;
  config.cmsisDapFlashAlgorithmPath = targetConfig.cmsisDapFlashAlgorithmPath;
  config.cmsisDapXrSampling = targetConfig.cmsisDapXrSampling;
  config.flashBeforeDebug = targetConfig.flashBeforeDebug;
  if (targetConfig.runToEntryPoint === undefined) delete config.runToEntryPoint;
  else config.runToEntryPoint = targetConfig.runToEntryPoint;
}
