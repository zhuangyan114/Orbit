import { describe, expect, it } from 'vitest';
import { OzoneBackend } from './commander';
import type { FastDataSampleSpec } from './types';

type BackendInternals = {
  symbols: Array<{ name: string; address: number; size: number; type?: string }>;
  dwarfInfo: {
    varToType: Map<string, string>;
    typeDefs: Map<string, {
      name: string;
      byteSize: number;
      kind: 'struct' | 'union' | 'base' | 'pointer' | 'array' | 'enum' | 'subroutine';
      fields?: Array<{ name: string; typeOffset: string; byteOffset: number }>;
      enumerators?: Array<{ name: string; value: string }>;
      typeOffset?: string;
      arrayCount?: number;
      encoding?: string;
    }>;
  };
  targetReadMemory: (address: number, size: number) => Promise<Uint8Array | null>;
};

describe('OzoneBackend multi-level pointer support', () => {
  it('samples a scalar through two-level pointer chain (base->ptr1->ptr2->scalar)', async () => {
    const backend = new OzoneBackend();
    const internal = backend as unknown as BackendInternals;

    // Setup: up_yaw (UpYaw_t*) -> smc (SmcInstance_s*) -> u (float)
    internal.symbols = [{ name: 'up_yaw', address: 0x2000_0100, size: 4 }];
    internal.dwarfInfo = {
      varToType: new Map([['up_yaw', 'up-yaw-ptr-type']]),
      typeDefs: new Map([
        ['up-yaw-ptr-type', { name: 'UpYaw_t*', byteSize: 4, kind: 'pointer', typeOffset: 'up-yaw-type' }],
        ['up-yaw-type', {
          name: 'UpYaw_t',
          byteSize: 64,
          kind: 'struct',
          fields: [
            { name: 'target_ac_Angle', typeOffset: 'float-type', byteOffset: 0 },
            { name: 'actual_Angle', typeOffset: 'float-type', byteOffset: 4 },
            { name: 'smc', typeOffset: 'smc-ptr-type', byteOffset: 8 },
          ],
        }],
        ['smc-ptr-type', { name: 'SmcInstance_s*', byteSize: 4, kind: 'pointer', typeOffset: 'smc-type' }],
        ['smc-type', {
          name: 'SmcInstance_s',
          byteSize: 32,
          kind: 'struct',
          fields: [
            { name: 'x', typeOffset: 'float-type', byteOffset: 0 },
            { name: 'u', typeOffset: 'float-type', byteOffset: 4 },
            { name: 'epsilon', typeOffset: 'float-type', byteOffset: 8 },
          ],
        }],
        ['float-type', { name: 'float', byteSize: 4, kind: 'base', encoding: 'float' }],
      ]),
    };

    // Memory layout:
    // 0x2000_0100: up_yaw base pointer -> 0x2000_1000 (UpYaw_t instance)
    // 0x2000_1008: up_yaw->smc pointer -> 0x2000_2000 (SmcInstance_s instance)
    // 0x2000_2004: smc->u = -530.78 (float)
    internal.targetReadMemory = async (address: number, size: number) => {
      if (address === 0x2000_0100 && size === 4) return Uint8Array.from([0x00, 0x10, 0x00, 0x20]); // -> 0x2000_1000
      if (address === 0x2000_1008 && size === 4) return Uint8Array.from([0x00, 0x20, 0x00, 0x20]); // -> 0x2000_2000
      if (address === 0x2000_2004 && size === 4) {
        // -530.78 as IEEE 754 float
        const view = new DataView(new ArrayBuffer(4));
        view.setFloat32(0, -530.78, true);
        return new Uint8Array(view.buffer);
      }
      return null;
    };

    const planResult = await backend.execute({
      cmd: 'prepareFastDataSampling',
      expressions: ['up_yaw.smc.u'],
    });

    expect(planResult.ok).toBe(true);
    if (!planResult.ok) throw new Error(planResult.error);
    const plan = planResult.data as Array<{ expression: string; spec?: FastDataSampleSpec; error?: string }>;
    expect(plan[0].spec).toBeDefined();
    expect(plan[0].spec?.pointerChain).toBeDefined();
    expect(plan[0].spec?.pointerChain?.length).toBe(3);

    const readResult = await backend.execute({ cmd: 'readFastDataSampling', specs: [plan[0].spec!] });

    expect(readResult.ok).toBe(true);
    if (!readResult.ok) throw new Error(readResult.error);
    const values = readResult.data as Array<{ expression: string; value: number; display: string }>;
    expect(values[0]).toMatchObject({
      expression: 'up_yaw.smc.u',
      value: expect.closeTo(-530.78, 0.01),
      display: expect.stringContaining('-530.78'),
    });

    plan[0].spec!.pointerChain![1].offset = 0x1000;
    const cachedPlanResult = await backend.execute({
      cmd: 'prepareFastDataSampling',
      expressions: ['up_yaw.smc.u'],
    });
    expect(cachedPlanResult.ok).toBe(true);
    if (!cachedPlanResult.ok) throw new Error(cachedPlanResult.error);
    const cachedPlan = cachedPlanResult.data as Array<{ spec?: FastDataSampleSpec }>;
    expect(cachedPlan[0].spec?.pointerChain?.[1].offset).toBe(8);
  });

  it('rejects multi-level pointer when intermediate pointer is NULL', async () => {
    const backend = new OzoneBackend();
    const internal = backend as unknown as BackendInternals;

    internal.symbols = [{ name: 'up_yaw', address: 0x2000_0100, size: 4 }];
    internal.dwarfInfo = {
      varToType: new Map([['up_yaw', 'up-yaw-ptr-type']]),
      typeDefs: new Map([
        ['up-yaw-ptr-type', { name: 'UpYaw_t*', byteSize: 4, kind: 'pointer', typeOffset: 'up-yaw-type' }],
        ['up-yaw-type', {
          name: 'UpYaw_t',
          byteSize: 64,
          kind: 'struct',
          fields: [{ name: 'smc', typeOffset: 'smc-ptr-type', byteOffset: 8 }],
        }],
        ['smc-ptr-type', { name: 'SmcInstance_s*', byteSize: 4, kind: 'pointer', typeOffset: 'smc-type' }],
        ['smc-type', {
          name: 'SmcInstance_s',
          byteSize: 32,
          kind: 'struct',
          fields: [{ name: 'u', typeOffset: 'float-type', byteOffset: 4 }],
        }],
        ['float-type', { name: 'float', byteSize: 4, kind: 'base', encoding: 'float' }],
      ]),
    };

    internal.targetReadMemory = async (address: number) => {
      if (address === 0x2000_0100) return Uint8Array.from([0x00, 0x10, 0x00, 0x20]); // valid up_yaw
      if (address === 0x2000_1008) return Uint8Array.from([0x00, 0x00, 0x00, 0x00]); // NULL smc pointer
      return null;
    };

    const planResult = await backend.execute({
      cmd: 'prepareFastDataSampling',
      expressions: ['up_yaw.smc.u'],
    });
    expect(planResult.ok).toBe(true);
    if (!planResult.ok) throw new Error(planResult.error);
    const plan = planResult.data as Array<{ expression: string; spec?: FastDataSampleSpec; error?: string }>;

    const readResult = await backend.execute({ cmd: 'readFastDataSampling', specs: [plan[0].spec!] });

    expect(readResult.ok).toBe(true);
    if (!readResult.ok) throw new Error(readResult.error);
    const values = readResult.data as Array<{ expression: string; error?: string }>;
    expect(values[0].error).toBeDefined();
    expect(values[0].error).toContain('read failed');
  });

  it('supports a multi-level pointer chain rooted in a global struct', async () => {
    const backend = new OzoneBackend();
    const internal = backend as unknown as BackendInternals;
    internal.symbols = [{ name: 'root', address: 0x2000_0300, size: 16 }];
    internal.dwarfInfo = {
      varToType: new Map([['root', 'root-type']]),
      typeDefs: new Map([
        ['root-type', {
          name: 'Root', byteSize: 16, kind: 'struct',
          fields: [{ name: 'a', typeOffset: 'a-pointer', byteOffset: 4 }],
        }],
        ['a-pointer', { name: 'A*', byteSize: 4, kind: 'pointer', typeOffset: 'a-type' }],
        ['a-type', {
          name: 'A', byteSize: 16, kind: 'struct',
          fields: [{ name: 'b', typeOffset: 'b-pointer', byteOffset: 8 }],
        }],
        ['b-pointer', { name: 'B*', byteSize: 4, kind: 'pointer', typeOffset: 'b-type' }],
        ['b-type', {
          name: 'B', byteSize: 8, kind: 'struct',
          fields: [{ name: 'value', typeOffset: 'float-type', byteOffset: 4 }],
        }],
        ['float-type', { name: 'float', byteSize: 4, kind: 'base', encoding: 'float' }],
      ]),
    };
    internal.targetReadMemory = async (address, size) => {
      if (address === 0x2000_0304 && size === 4) return Uint8Array.from([0x00, 0x10, 0x00, 0x20]);
      if (address === 0x2000_1008 && size === 4) return Uint8Array.from([0x00, 0x20, 0x00, 0x20]);
      if (address === 0x2000_2004 && size === 4) {
        const view = new DataView(new ArrayBuffer(4));
        view.setFloat32(0, 6.25, true);
        return new Uint8Array(view.buffer);
      }
      return null;
    };

    const planResult = await backend.execute({
      cmd: 'prepareFastDataSampling',
      expressions: ['root.a->b->value'],
    });
    expect(planResult.ok).toBe(true);
    if (!planResult.ok) throw new Error(planResult.error);
    const plan = planResult.data as Array<{ spec?: FastDataSampleSpec }>;
    expect(plan[0].spec?.pointerChain).toHaveLength(3);

    const readResult = await backend.execute({ cmd: 'readFastDataSampling', specs: [plan[0].spec!] });
    expect(readResult.ok).toBe(true);
    if (!readResult.ok) throw new Error(readResult.error);
    expect((readResult.data as Array<{ value: number }>)[0].value).toBeCloseTo(6.25, 0.01);
  });

  it('preserves single-level pointer behavior (down_yaw.message.out_velocity)', async () => {
    const backend = new OzoneBackend();
    const internal = backend as unknown as BackendInternals;

    internal.symbols = [{ name: 'down_yaw', address: 0x2000721c, size: 4 }];
    internal.dwarfInfo = {
      varToType: new Map([['down_yaw', 'pointer-type']]),
      typeDefs: new Map([
        ['pointer-type', { name: 'Motor_t*', byteSize: 4, kind: 'pointer', typeOffset: 'motor-type' }],
        ['motor-type', {
          name: 'Motor_t',
          byteSize: 16,
          kind: 'struct',
          fields: [{ name: 'message', typeOffset: 'message-type', byteOffset: 4 }],
        }],
        ['message-type', {
          name: 'MotorMessage_t',
          byteSize: 12,
          kind: 'struct',
          fields: [{ name: 'out_velocity', typeOffset: 'float-type', byteOffset: 8 }],
        }],
        ['float-type', { name: 'float', byteSize: 4, kind: 'base', encoding: 'float' }],
      ]),
    };

    internal.targetReadMemory = async address => {
      if (address === 0x2000721c) return Uint8Array.from([0x00, 0x10, 0x00, 0x20]);
      if (address === 0x2000100c) return Uint8Array.from([0x00, 0x00, 0x20, 0x40]); // 2.5
      return null;
    };

    const planResult = await backend.execute({
      cmd: 'prepareFastDataSampling',
      expressions: ['down_yaw.message.out_velocity'],
    });

    expect(planResult.ok).toBe(true);
    if (!planResult.ok) throw new Error(planResult.error);
    const plan = planResult.data as Array<{ expression: string; spec?: FastDataSampleSpec; error?: string }>;
    expect(plan[0].spec?.pointerAddress).toBe(0x2000721c);
    expect(plan[0].spec?.pointeeOffset).toBe(12);
    expect(plan[0].spec?.pointerChain).toBeUndefined();

    const readResult = await backend.execute({ cmd: 'readFastDataSampling', specs: [plan[0].spec!] });
    expect(readResult.ok).toBe(true);
    if (!readResult.ok) throw new Error(readResult.error);
    const values = readResult.data as Array<{ value: number }>;
    expect(values[0].value).toBeCloseTo(2.5, 0.01);
  });

  it('rejects pointer chains deeper than three dereferences', async () => {
    const backend = new OzoneBackend();
    const internal = backend as unknown as BackendInternals;

    // Setup: a -> b* -> c* -> d* -> scalar (should reject at planning stage)
    internal.symbols = [{ name: 'a', address: 0x2000_0100, size: 4 }];
    internal.dwarfInfo = {
      varToType: new Map([['a', 'a-ptr-type']]),
      typeDefs: new Map([
        ['a-ptr-type', { name: 'A*', byteSize: 4, kind: 'pointer', typeOffset: 'a-type' }],
        ['a-type', { name: 'A', byteSize: 16, kind: 'struct', fields: [{ name: 'b', typeOffset: 'b-ptr-type', byteOffset: 0 }] }],
        ['b-ptr-type', { name: 'B*', byteSize: 4, kind: 'pointer', typeOffset: 'b-type' }],
        ['b-type', { name: 'B', byteSize: 16, kind: 'struct', fields: [{ name: 'c', typeOffset: 'c-ptr-type', byteOffset: 0 }] }],
        ['c-ptr-type', { name: 'C*', byteSize: 4, kind: 'pointer', typeOffset: 'c-type' }],
        ['c-type', { name: 'C', byteSize: 16, kind: 'struct', fields: [{ name: 'd', typeOffset: 'd-ptr-type', byteOffset: 0 }] }],
        ['d-ptr-type', { name: 'D*', byteSize: 4, kind: 'pointer', typeOffset: 'd-type' }],
        ['d-type', { name: 'D', byteSize: 16, kind: 'struct', fields: [{ name: 'value', typeOffset: 'float-type', byteOffset: 0 }] }],
        ['float-type', { name: 'float', byteSize: 4, kind: 'base', encoding: 'float' }],
      ]),
    };

    const planResult = await backend.execute({
      cmd: 'prepareFastDataSampling',
      expressions: ['a.b.c.d.value'],
    });

    expect(planResult.ok).toBe(true);
    if (!planResult.ok) throw new Error(planResult.error);
    const plan = planResult.data as Array<{ expression: string; spec?: unknown; error?: string }>;
    expect(plan[0].expression).toBe('a.b.c.d.value');
    expect(plan[0].spec).toBeUndefined();
    expect(plan[0].error).toContain('scalar struct fields only');
  });

  it('rejects pointer-offset overflow without wrapping the target address', async () => {
    const backend = new OzoneBackend();
    const internal = backend as unknown as BackendInternals;
    const readAddresses: number[] = [];
    internal.targetReadMemory = async (address, size) => {
      readAddresses.push(address);
      if (address === 0x2000_0100 && size === 4) return Uint8Array.from([0x00, 0x10, 0x00, 0x20]);
      if (address === 0x2000_1008 && size === 4) return Uint8Array.from([0xFC, 0xFF, 0xFF, 0xFF]);
      return null;
    };
    const spec: FastDataSampleSpec = {
      expression: 'overflow',
      address: 0x2000_0100,
      size: 4,
      pointerChain: [
        { pointerAddress: 0x2000_0100, offset: 0 },
        { pointerAddress: 0, offset: 8 },
        { pointerAddress: 0, offset: 8 },
      ],
    };

    const result = await backend.execute({ cmd: 'readFastDataSampling', specs: [spec] });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    expect((result.data as Array<{ error?: string }>)[0].error).toContain('read failed');
    expect(readAddresses).toEqual([0x2000_0100, 0x2000_1008]);
  });

  it('handles direct struct field access without pointers', async () => {
    const backend = new OzoneBackend();
    const internal = backend as unknown as BackendInternals;

    internal.symbols = [{ name: 'direct', address: 0x2000_0100, size: 8 }];
    internal.dwarfInfo = {
      varToType: new Map([['direct', 'direct-type']]),
      typeDefs: new Map([
        ['direct-type', { name: 'Direct', byteSize: 8, kind: 'struct', fields: [{ name: 'value', typeOffset: 'float-type', byteOffset: 4 }] }],
        ['float-type', { name: 'float', byteSize: 4, kind: 'base', encoding: 'float' }],
      ]),
    };

    internal.targetReadMemory = async (address: number, size: number) => {
      if (address === 0x2000_0104 && size === 4) {
        const view = new DataView(new ArrayBuffer(4));
        view.setFloat32(0, 3.14, true);
        return new Uint8Array(view.buffer);
      }
      return null;
    };

    const planResult = await backend.execute({
      cmd: 'prepareFastDataSampling',
      expressions: ['direct.value'],
    });

    expect(planResult.ok).toBe(true);
    if (!planResult.ok) throw new Error(planResult.error);
    const plan = planResult.data as Array<{ expression: string; spec?: FastDataSampleSpec; error?: string }>;
    expect(plan[0].spec?.address).toBe(0x2000_0104);
    expect(plan[0].spec?.pointerAddress).toBeUndefined();
    expect(plan[0].spec?.pointerChain).toBeUndefined();

    const readResult = await backend.execute({ cmd: 'readFastDataSampling', specs: [plan[0].spec!] });
    expect(readResult.ok).toBe(true);
    if (!readResult.ok) throw new Error(readResult.error);
    const values = readResult.data as Array<{ value: number }>;
    expect(values[0].value).toBeCloseTo(3.14, 0.01);
  });
});
