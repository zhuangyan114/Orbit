import {
  CmsisDapTransport,
  DebugProbe,
} from '../ozone-backend/types';

export interface NormalizedDapLaunchConfig {
  probe: DebugProbe;
  cmsisDapTransport: CmsisDapTransport;
  cmsisDapSerial?: string;
  cmsisDapVid?: string;
  cmsisDapPid?: string;
  cmsisDapFlashAlgorithmPath?: string;
  flashBeforeDebug: boolean;
  runToEntryPoint?: string | false;
}

export class DapLaunchConfigError extends Error {
  readonly errorCode = 'InvalidConfiguration' as const;

  constructor(
    readonly field: 'probe' | 'cmsisDapTransport',
    value: unknown,
  ) {
    const received = typeof value === 'string' ? `"${value}"` : String(value);
    const allowed = field === 'probe'
      ? 'jlink or cmsis-dap'
      : 'auto, hid, or winusb';
    super(`InvalidConfiguration: ${field} must be one of ${allowed}; received ${received}`);
    this.name = 'DapLaunchConfigError';
    Object.setPrototypeOf(this, DapLaunchConfigError.prototype);
  }
}

export function normalizeDapLaunchConfig(input: unknown): NormalizedDapLaunchConfig {
  const args = input && typeof input === 'object'
    ? input as Record<string, unknown>
    : {};
  if (args.probe !== undefined && args.probe !== 'jlink' && args.probe !== 'cmsis-dap') {
    throw new DapLaunchConfigError('probe', args.probe);
  }
  if (args.cmsisDapTransport !== undefined
    && args.cmsisDapTransport !== 'auto'
    && args.cmsisDapTransport !== 'hid'
    && args.cmsisDapTransport !== 'winusb') {
    throw new DapLaunchConfigError('cmsisDapTransport', args.cmsisDapTransport);
  }
  const config: NormalizedDapLaunchConfig = {
    probe: args.probe === 'cmsis-dap' ? 'cmsis-dap' : 'jlink',
    cmsisDapTransport: args.cmsisDapTransport === undefined ? 'auto' : args.cmsisDapTransport,
    flashBeforeDebug: args.flashBeforeDebug !== false,
  };

  if (config.probe === 'cmsis-dap') {
    const entry = typeof args.runToEntryPoint === 'string' ? args.runToEntryPoint.trim() : '';
    config.runToEntryPoint = args.runToEntryPoint === false ? false : entry || 'main';
  }

  for (const field of ['cmsisDapSerial', 'cmsisDapVid', 'cmsisDapPid', 'cmsisDapFlashAlgorithmPath'] as const) {
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
  config.cmsisDapTransport = targetConfig.cmsisDapTransport;
  config.cmsisDapSerial = targetConfig.cmsisDapSerial;
  config.cmsisDapVid = targetConfig.cmsisDapVid;
  config.cmsisDapPid = targetConfig.cmsisDapPid;
  config.cmsisDapFlashAlgorithmPath = targetConfig.cmsisDapFlashAlgorithmPath;
  config.flashBeforeDebug = targetConfig.flashBeforeDebug;
  if (targetConfig.runToEntryPoint === undefined) delete config.runToEntryPoint;
  else config.runToEntryPoint = targetConfig.runToEntryPoint;
}

export function cmsisDapFlashUnsupportedMessage(): string {
  return 'CMSIS-DAP Flash Algorithm for STM32F407VET6 is not implemented; set flashBeforeDebug to false to skip flashing.';
}
