import { describe, expect, it } from 'vitest';
import { applyNormalizedDapLaunchConfig, normalizeDapLaunchConfig } from './dap-launch-config';

describe('DAP launch probe configuration', () => {
  it('defaults to the existing J-Link path and enables flashing', () => {
    expect(normalizeDapLaunchConfig({})).toEqual({
      probe: 'jlink',
      cmsisDapTransport: 'auto',
      flashBeforeDebug: true,
    });
  });

  it('accepts an explicit J-Link probe', () => {
    expect(normalizeDapLaunchConfig({ probe: 'jlink' })).toMatchObject({
      probe: 'jlink',
      cmsisDapTransport: 'auto',
      flashBeforeDebug: true,
    });
  });

  it('preserves CMSIS-DAP transport and device selectors', () => {
    expect(normalizeDapLaunchConfig({
      probe: 'cmsis-dap',
      cmsisDapTransport: 'hid',
      cmsisDapSerial: '  CMSIS-123  ',
      cmsisDapVid: 'C251',
      cmsisDapPid: 'F001',
      cmsisDapFlashAlgorithmPath: '  C:/licensed/stm32f407.flm  ',
      flashBeforeDebug: false,
    })).toEqual({
      probe: 'cmsis-dap',
      cmsisDapTransport: 'hid',
      cmsisDapSerial: 'CMSIS-123',
      cmsisDapVid: 'C251',
      cmsisDapPid: 'F001',
      cmsisDapFlashAlgorithmPath: 'C:/licensed/stm32f407.flm',
      flashBeforeDebug: false,
      runToEntryPoint: 'main',
    });
  });

  it('defaults CMSIS-DAP startup stops to main without changing J-Link behavior', () => {
    expect(normalizeDapLaunchConfig({ probe: 'cmsis-dap' })).toMatchObject({
      probe: 'cmsis-dap',
      runToEntryPoint: 'main',
    });
    expect(normalizeDapLaunchConfig({ probe: 'jlink', runToEntryPoint: 'ignored' }))
      .not.toHaveProperty('runToEntryPoint');
  });

  it('accepts a trimmed CMSIS-DAP entry symbol or explicit disable', () => {
    expect(normalizeDapLaunchConfig({
      probe: 'cmsis-dap',
      runToEntryPoint: '  app_main  ',
    })).toMatchObject({ runToEntryPoint: 'app_main' });
    expect(normalizeDapLaunchConfig({
      probe: 'cmsis-dap',
      runToEntryPoint: false,
    })).toMatchObject({ runToEntryPoint: false });
  });

  it('rejects an explicitly invalid probe instead of falling back to J-Link', () => {
    expect(() => normalizeDapLaunchConfig({ probe: 'cmsis_dap' })).toThrowError(
      'InvalidConfiguration: probe must be one of jlink or cmsis-dap; received "cmsis_dap"',
    );
    expect(() => normalizeDapLaunchConfig({ probe: 'CMSIS-DAP' })).toThrowError(
      'InvalidConfiguration: probe must be one of jlink or cmsis-dap; received "CMSIS-DAP"',
    );
    expect(() => normalizeDapLaunchConfig({ probe: 'foo' })).toThrowError(
      'InvalidConfiguration: probe must be one of jlink or cmsis-dap; received "foo"',
    );
  });

  it('rejects an explicitly invalid CMSIS-DAP transport instead of falling back to auto', () => {
    expect(() => normalizeDapLaunchConfig({ cmsisDapTransport: 'usb' })).toThrowError(
      'InvalidConfiguration: cmsisDapTransport must be one of auto, cmsis-dap-v2, cmsis-dap, hid, or winusb; received "usb"',
    );
  });

  it('writes the licensed user Flash Algorithm path into the final launch config', () => {
    const config: Record<string, unknown> = {};
    const normalized = normalizeDapLaunchConfig({
      probe: 'cmsis-dap',
      cmsisDapFlashAlgorithmPath: 'C:/licensed/stm32f407.flm',
    });
    applyNormalizedDapLaunchConfig(config, normalized);
    expect(config).toMatchObject({
      probe: 'cmsis-dap',
      cmsisDapFlashAlgorithmPath: 'C:/licensed/stm32f407.flm',
      flashBeforeDebug: true,
      runToEntryPoint: 'main',
    });
  });
});
