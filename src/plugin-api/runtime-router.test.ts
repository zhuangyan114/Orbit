import { beforeEach, describe, expect, it, vi } from 'vitest';

const vscodeState = vi.hoisted(() => ({ activeDebugSession: undefined as any }));

vi.mock('vscode', () => ({
  debug: vscodeState,
}));

import { OzoneBackend } from '../ozone-backend/commander';
import { RuntimeRouter } from './runtime-router';

describe('RuntimeRouter active DAP ownership', () => {
  beforeEach(() => {
    vscodeState.activeDebugSession = undefined;
  });

  it('does not fall back to the extension backend when an active Orbit DAP request fails', async () => {
    const backend = { execute: vi.fn() } as unknown as OzoneBackend;
    vscodeState.activeDebugSession = {
      type: 'orbit',
      customRequest: vi.fn(async () => { throw new Error('DAP unavailable'); }),
    };
    const router = new RuntimeRouter(backend);

    expect(await router.getTargetState()).toBe('error');
    expect(await router.readSignals([{ alias: 'count', expression: 'count' }])).toEqual([
      expect.objectContaining({ alias: 'count', error: 'DAP unavailable' }),
    ]);
    expect(await router.writeMany([{ expression: 'count', value: 42 }])).toEqual([
      expect.objectContaining({ expression: 'count', ok: false, error: 'DAP unavailable' }),
    ]);
    expect(backend.execute).not.toHaveBeenCalled();
  });

  it('uses the extension backend only when there is no active Orbit session', async () => {
    const backend = {
      execute: vi.fn(async (command: { cmd: string }) => {
        if (command.cmd === 'getTargetState') return { ok: true, data: 'halted' };
        if (command.cmd === 'evaluateExpression') {
          return { ok: true, data: { expression: 'count', value: 7, display: '7', hex: '0x7' } };
        }
        if (command.cmd === 'setWatchValue') return { ok: true, data: {} };
        return { ok: false, error: 'unexpected' };
      }),
    } as unknown as OzoneBackend;
    const router = new RuntimeRouter(backend);

    expect(await router.getTargetState()).toBe('halted');
    expect((await router.readSignals([{ alias: 'count', expression: 'count' }]))[0]).toMatchObject({ value: 7 });
    expect((await router.writeMany([{ expression: 'count', value: 42 }]))[0]).toMatchObject({ ok: true });
    expect(backend.execute).toHaveBeenCalledTimes(3);
  });

  it('forwards a resolved field address and type to the active DAP session', async () => {
    const backend = { execute: vi.fn() } as unknown as OzoneBackend;
    const customRequest = vi.fn(async () => ({ ok: true }));
    vscodeState.activeDebugSession = { type: 'ozone', customRequest };
    const router = new RuntimeRouter(backend);

    await expect(router.writeMany([
      { expression: 'up_yaw->target_ac_Angle', value: 0.25, address: 0x2000712C, typeName: 'float' },
    ])).resolves.toEqual([
      expect.objectContaining({ expression: 'up_yaw->target_ac_Angle', ok: true }),
    ]);
    expect(customRequest).toHaveBeenCalledWith('setWatchValue', {
      expression: 'up_yaw->target_ac_Angle',
      value: 0.25,
      address: 0x2000712C,
      typeName: 'float',
    });
    expect(backend.execute).not.toHaveBeenCalled();
  });
});
