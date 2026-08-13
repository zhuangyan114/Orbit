import * as vscode from 'vscode';
import { describe, expect, it, vi } from 'vitest';
import { OzoneBackend } from '../ozone-backend/commander';
import { AutomationError } from './protocol';
import { RuntimeRouter } from './runtime-router';

function fakeSession(customRequest: (cmd: string, args?: unknown) => Promise<unknown>): vscode.DebugSession {
  return { id: 'session-1', type: 'orbit', customRequest } as unknown as vscode.DebugSession;
}

describe('RuntimeRouter explicit session routing', () => {
  it('routes through the exact SessionRef and never falls back to the extension backend', async () => {
    const backend = { execute: vi.fn() } as unknown as OzoneBackend;
    const customRequest = vi.fn(async () => {
      throw new Error('DAP unavailable');
    });
    const resolveSession = vi.fn(() => fakeSession(customRequest));
    const router = new RuntimeRouter(backend, { resolveSession });
    const ref = { sessionId: 'session-1', sessionGeneration: 2 };

    expect(await router.getTargetState(ref)).toBe('error');
    expect(await router.readSignals([{ alias: 'count', expression: 'count' }], ref)).toEqual([
      expect.objectContaining({ alias: 'count', error: 'DAP unavailable' }),
    ]);
    expect(await router.writeMany([{ expression: 'count', value: 42 }], ref)).toEqual([
      expect.objectContaining({ expression: 'count', ok: false, error: 'DAP unavailable' }),
    ]);
    expect(resolveSession).toHaveBeenCalledTimes(3);
    expect(resolveSession).toHaveBeenNthCalledWith(1, ref);
    expect(resolveSession).toHaveBeenNthCalledWith(2, ref);
    expect(resolveSession).toHaveBeenNthCalledWith(3, ref);
    expect(backend.execute).not.toHaveBeenCalled();
  });

  it('propagates a frozen AutomationError from the resolver without backend fallback', async () => {
    const backend = { execute: vi.fn() } as unknown as OzoneBackend;
    const router = new RuntimeRouter(backend, {
      resolveSession: () => {
        throw new AutomationError('SessionChanged', 'generation changed', false, {
          expectedGeneration: 1,
          actualGeneration: 2,
        });
      },
    });

    await expect(
      router.getTargetState({ sessionId: 'session-1', sessionGeneration: 1 }),
    ).rejects.toMatchObject({ errorCode: 'SessionChanged' });
    expect(backend.execute).not.toHaveBeenCalled();
  });

  it('uses the extension backend only when no ref resolves to a session', async () => {
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
    // No routing hooks: the legacy constructor has no session to resolve.
    const router = new RuntimeRouter(backend);

    expect(await router.getTargetState()).toBe('halted');
    expect((await router.readSignals([{ alias: 'count', expression: 'count' }]))[0]).toMatchObject({ value: 7 });
    expect((await router.writeMany([{ expression: 'count', value: 42 }]))[0]).toMatchObject({ ok: true });
    expect(backend.execute).toHaveBeenCalledTimes(3);
  });

  it('resolves the injected currentRef for legacy callers that pass no ref', async () => {
    const backend = { execute: vi.fn() } as unknown as OzoneBackend;
    const customRequest = vi.fn(async () => ({ ok: true }));
    const currentRef = vi.fn(() => ({ sessionId: 'session-1', sessionGeneration: 3 }));
    const resolveSession = vi.fn(() => fakeSession(customRequest));
    const router = new RuntimeRouter(backend, { resolveSession, currentRef });

    expect(await router.writeMany([{ expression: 'count', value: 42 }])).toEqual([
      expect.objectContaining({ expression: 'count', ok: true }),
    ]);
    expect(currentRef).toHaveBeenCalledTimes(1);
    expect(resolveSession).toHaveBeenCalledWith({ sessionId: 'session-1', sessionGeneration: 3 });
    expect(backend.execute).not.toHaveBeenCalled();
  });

  it('falls back to the extension backend when the injected currentRef is empty', async () => {
    const backend = {
      execute: vi.fn(async () => ({ ok: true, data: 'halted' })),
    } as unknown as OzoneBackend;
    const resolveSession = vi.fn();
    const router = new RuntimeRouter(backend, {
      resolveSession,
      currentRef: () => undefined,
    });

    expect(await router.getTargetState()).toBe('halted');
    expect(resolveSession).not.toHaveBeenCalled();
    expect(backend.execute).toHaveBeenCalledTimes(1);
  });

  it('forwards a resolved field address and type to the exact DAP session', async () => {
    const backend = { execute: vi.fn() } as unknown as OzoneBackend;
    const customRequest = vi.fn(async () => ({ ok: true }));
    const session = fakeSession(customRequest);
    const router = new RuntimeRouter(backend, { resolveSession: () => session });
    const ref = { sessionId: 'session-1', sessionGeneration: 2 };

    await expect(
      router.writeMany(
        [{ expression: 'up_yaw->target_ac_Angle', value: 0.25, address: 0x2000712C, typeName: 'float' }],
        ref,
      ),
    ).resolves.toEqual([
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

  it('control routes through the exact DAP session and returns the structured outcome', async () => {
    const backend = { execute: vi.fn() } as unknown as OzoneBackend;
    const customRequest = vi.fn(async () => ({
      state: 'halted',
      stopReason: 'pause',
      pc: '0x8000480',
    }));
    const router = new RuntimeRouter(backend, { resolveSession: () => fakeSession(customRequest) });
    const ref = { sessionId: 'session-1', sessionGeneration: 2 };

    await expect(
      router.control(ref, { action: 'pause', sessionGeneration: 2, threadId: 1 }),
    ).resolves.toEqual({ state: 'halted', stopReason: 'pause', pc: '0x8000480' });
    expect(customRequest).toHaveBeenCalledWith('orbitAutomationControl', {
      action: 'pause',
      sessionGeneration: 2,
      threadId: 1,
    });
    expect(backend.execute).not.toHaveBeenCalled();
  });

  it('control maps a structured DAP failure onto the frozen error codes', async () => {
    const backend = { execute: vi.fn() } as unknown as OzoneBackend;
    const customRequest = vi.fn(async () => ({
      state: 'unknown',
      errorCode: 'TargetBusy',
      message: 'another automation control is in progress',
    }));
    const router = new RuntimeRouter(backend, { resolveSession: () => fakeSession(customRequest) });

    await expect(
      router.control({ sessionId: 'session-1', sessionGeneration: 2 }, { action: 'continue', sessionGeneration: 2 }),
    ).rejects.toMatchObject({ errorCode: 'TargetBusy', retryable: true });
    expect(backend.execute).not.toHaveBeenCalled();
  });

  it('control maps a rejected customRequest with a body onto the frozen error codes', async () => {
    const backend = { execute: vi.fn() } as unknown as OzoneBackend;
    const rejection = Object.assign(
      new Error('TargetControlFailed: run rejected'),
      { body: { errorCode: 'TargetControlFailed', message: 'run rejected', targetState: 'halted' } },
    );
    const customRequest = vi.fn(async () => { throw rejection; });
    const router = new RuntimeRouter(backend, { resolveSession: () => fakeSession(customRequest) });

    await expect(
      router.control({ sessionId: 'session-1', sessionGeneration: 2 }, { action: 'continue', sessionGeneration: 2 }),
    ).rejects.toMatchObject({ errorCode: 'InternalError', retryable: false });
    expect(backend.execute).not.toHaveBeenCalled();
  });

  it('control maps a bodiless rejection message prefix onto the frozen error codes', async () => {
    const backend = { execute: vi.fn() } as unknown as OzoneBackend;
    const customRequest = vi.fn(async () => {
      throw new Error('TargetRunning: step requested while running');
    });
    const router = new RuntimeRouter(backend, { resolveSession: () => fakeSession(customRequest) });

    await expect(
      router.control({ sessionId: 'session-1', sessionGeneration: 2 }, { action: 'stepOver', sessionGeneration: 2, threadId: 1 }),
    ).rejects.toMatchObject({ errorCode: 'TargetRunning', retryable: true });
  });

  it('control never falls back to the extension backend without a session', async () => {
    const backend = { execute: vi.fn(async () => ({ ok: true, data: 'halted' })) } as unknown as OzoneBackend;
    const router = new RuntimeRouter(backend);

    await expect(
      router.control({ sessionId: 'session-1', sessionGeneration: 2 }, { action: 'pause', sessionGeneration: 2 }),
    ).rejects.toMatchObject({ errorCode: 'NoActiveSession' });
    expect(backend.execute).not.toHaveBeenCalled();
  });

  it('only stepping controls map a running target-state message to TargetRunning', async () => {
    const backend = { execute: vi.fn() } as unknown as OzoneBackend;
    const customRequest = vi.fn(async () => {
      throw new Error('TargetStateInvalid: reset-run returned running');
    });
    const router = new RuntimeRouter(backend, { resolveSession: () => fakeSession(customRequest) });

    // Non-step (reset): the "still running" message must NOT leak the
    // step-only frozen TargetRunning code.
    await expect(
      router.control({ sessionId: 'session-1', sessionGeneration: 2 }, { action: 'reset', sessionGeneration: 2 }),
    ).rejects.toMatchObject({ errorCode: 'InternalError' });
    // Step: TargetRunning is valid for stepping controls.
    await expect(
      router.control(
        { sessionId: 'session-1', sessionGeneration: 2 },
        { action: 'stepOver', sessionGeneration: 2, threadId: 1 },
      ),
    ).rejects.toMatchObject({ errorCode: 'TargetRunning', retryable: true });
  });

  it('resolveSession throws NoActiveSession without hooks and controlSession drives the session', async () => {
    const backend = { execute: vi.fn() } as unknown as OzoneBackend;
    const router = new RuntimeRouter(backend);
    let thrown: unknown;
    try {
      router.resolveSession({ sessionId: 's', sessionGeneration: 1 });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({ errorCode: 'NoActiveSession' });
    thrown = undefined;
    try {
      router.resolveSession(undefined);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({ errorCode: 'NoActiveSession' });
    expect(backend.execute).not.toHaveBeenCalled();

    const customRequest = vi.fn(async () => ({ state: 'halted', stopReason: 'pause' }));
    const session = fakeSession(customRequest);
    await expect(
      router.controlSession(session, { action: 'pause', sessionGeneration: 2 }),
    ).resolves.toEqual({ state: 'halted', stopReason: 'pause' });
    expect(customRequest).toHaveBeenCalledWith('orbitAutomationControl', { action: 'pause', sessionGeneration: 2 });
  });
});
