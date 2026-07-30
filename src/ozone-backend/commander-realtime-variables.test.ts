import { describe, expect, it } from 'vitest';
import { OzoneBackend } from './commander';

type BackendInternals = {
  symbols: Array<{ name: string; address: number; size: number }>;
  dwarfInfo: {
    varToType: Map<string, string>;
    typeDefs: Map<string, {
      name: string;
      byteSize: number;
      kind: 'struct' | 'base' | 'pointer' | 'array';
      fields?: Array<{ name: string; typeOffset: string; byteOffset: number }>;
      typeOffset?: string;
      arrayCount?: number;
      encoding?: string;
    }>;
  };
  targetReadMemory: (address: number, size: number) => Promise<Uint8Array | null>;
};

function setupInsDataBackend(): OzoneBackend {
  const backend = new OzoneBackend();
  const internal = backend as unknown as BackendInternals;
  internal.symbols = [{ name: 'ins_data', address: 0x200070e4, size: 40 }];
  internal.dwarfInfo = {
    varToType: new Map([['ins_data', 'ins-data-type']]),
    typeDefs: new Map([
      ['ins-data-type', {
        name: 'InsData_t',
        byteSize: 40,
        kind: 'struct',
        fields: [{ name: 'yaw', typeOffset: 'float-type', byteOffset: 8 }],
      }],
      ['float-type', { name: 'float', byteSize: 4, kind: 'base', encoding: 'float' }],
    ]),
  };
  return backend;
}

describe('OzoneBackend realtime variables', () => {
  it('plans a scalar struct field for fast Timeline sampling', async () => {
    const backend = setupInsDataBackend();

    const result = await backend.execute({
      cmd: 'prepareFastDataSampling',
      expressions: ['ins_data.yaw', 'ins_data->yaw'],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    const plan = result.data as Array<{ expression: string; spec?: { address: number; size: number; isFloat?: boolean } }>;
    expect(plan[0]).toMatchObject({
      expression: 'ins_data.yaw',
      spec: { address: 0x200070ec, size: 4, isFloat: true },
    });
    expect(plan[1].spec).toBeUndefined();
  });

  it('plans and reads a scalar through a nested struct array path', async () => {
    const backend = new OzoneBackend();
    const internal = backend as any;
    internal.symbols = [{ name: 'chassis', address: 0x20007000, size: 4 }];
    internal.dwarfInfo = {
      varToType: new Map([['chassis', 'chassis-pointer-type']]),
      typeDefs: new Map([
        ['chassis-pointer-type', { name: 'Chassis_t*', byteSize: 4, kind: 'pointer', typeOffset: 'chassis-type' }],
        ['chassis-type', {
          name: 'Chassis_t', byteSize: 32, kind: 'struct',
          fields: [{ name: 'chassis_motor', typeOffset: 'motor-array-type', byteOffset: 0 }],
        }],
        ['motor-array-type', { name: 'Motor_t[2]', byteSize: 32, kind: 'array', typeOffset: 'motor-type', arrayCount: 2 }],
        ['motor-type', {
          name: 'Motor_t', byteSize: 16, kind: 'struct',
          fields: [
            { name: 'target_velocity', typeOffset: 'float-type', byteOffset: 0 },
            { name: 'message', typeOffset: 'message-type', byteOffset: 4 },
          ],
        }],
        ['message-type', {
          name: 'MotorMessage_t', byteSize: 12, kind: 'struct',
          fields: [{ name: 'out_velocity', typeOffset: 'float-type', byteOffset: 8 }],
        }],
        ['float-type', { name: 'float', byteSize: 4, kind: 'base', encoding: 'float' }],
      ]),
    };
    internal.targetReadMemory = async (address: number) => {
      if (address === 0x20007000) return Uint8Array.from([0x00, 0x10, 0x00, 0x20]);
      if (address === 0x20001000) return Uint8Array.from([0x00, 0x00, 0xA0, 0x3F]);
      if (address === 0x2000100C) return Uint8Array.from([0x00, 0x00, 0x20, 0x40]);
      return null;
    };

    const planResult = await backend.execute({
      cmd: 'prepareFastDataSampling',
      expressions: [
        'chassis.chassis_motor[0].target_velocity',
        'chassis.chassis_motor[0].message.out_velocity',
      ],
    });

    expect(planResult.ok).toBe(true);
    if (!planResult.ok) throw new Error(planResult.error);
    const plan = planResult.data as Array<{
      spec?: { expression: string; address: number; pointerAddress?: number; pointeeOffset?: number; size: number };
    }>;
    expect(plan[0].spec).toMatchObject({
      pointerAddress: 0x20007000,
      pointeeOffset: 0,
      size: 4,
    });
    expect(plan[1].spec).toMatchObject({
      pointerAddress: 0x20007000,
      pointeeOffset: 12,
      size: 4,
    });

    const readResult = await backend.execute({
      cmd: 'readFastDataSampling',
      specs: plan.map(item => item.spec!),
    });

    expect(readResult.ok).toBe(true);
    if (!readResult.ok) throw new Error(readResult.error);
    expect(readResult.data).toEqual([
      expect.objectContaining({
        expression: 'chassis.chassis_motor[0].target_velocity',
        address: 0x20001000,
        display: '1.250000',
      }),
      expect.objectContaining({
        expression: 'chassis.chassis_motor[0].message.out_velocity',
        address: 0x2000100C,
        display: '2.500000',
      }),
    ]);
  });

  it('plans and reads a scalar through an array of struct pointers', async () => {
    const backend = new OzoneBackend();
    const internal = backend as any;
    internal.symbols = [{ name: 'chassis', address: 0x20007000, size: 4 }];
    internal.dwarfInfo = {
      varToType: new Map([['chassis', 'chassis-pointer-type']]),
      typeDefs: new Map([
        ['chassis-pointer-type', { name: 'Chassis_t*', byteSize: 4, kind: 'pointer', typeOffset: 'chassis-type' }],
        ['chassis-type', {
          name: 'Chassis_t', byteSize: 32, kind: 'struct',
          fields: [{ name: 'chassis_motor', typeOffset: 'motor-pointer-array-type', byteOffset: 8 }],
        }],
        ['motor-pointer-array-type', { name: 'Motor_t*[2]', byteSize: 8, kind: 'array', typeOffset: 'motor-pointer-type', arrayCount: 2 }],
        ['motor-pointer-type', { name: 'Motor_t*', byteSize: 4, kind: 'pointer', typeOffset: 'motor-type' }],
        ['motor-type', {
          name: 'Motor_t', byteSize: 32, kind: 'struct',
          fields: [
            { name: 'target_velocity', typeOffset: 'float-type', byteOffset: 4 },
            { name: 'message', typeOffset: 'message-type', byteOffset: 8 },
          ],
        }],
        ['message-type', {
          name: 'MotorMessage_t', byteSize: 16, kind: 'struct',
          fields: [{ name: 'out_velocity', typeOffset: 'float-type', byteOffset: 12 }],
        }],
        ['float-type', { name: 'float', byteSize: 4, kind: 'base', encoding: 'float' }],
      ]),
    };
    internal.targetReadMemory = async (address: number) => {
      if (address === 0x20007000) return Uint8Array.from([0x00, 0x10, 0x00, 0x20]);
      if (address === 0x20001008) return Uint8Array.from([0x00, 0x20, 0x00, 0x20]);
      if (address === 0x20002004) return Uint8Array.from([0x00, 0x00, 0xA0, 0x3F]);
      if (address === 0x20002014) return Uint8Array.from([0x00, 0x00, 0x20, 0x40]);
      return null;
    };

    const planResult = await backend.execute({
      cmd: 'prepareFastDataSampling',
      expressions: [
        'chassis.chassis_motor[0].target_velocity',
        'chassis.chassis_motor[0].message.out_velocity',
      ],
    });

    expect(planResult.ok).toBe(true);
    if (!planResult.ok) throw new Error(planResult.error);
    const plan = planResult.data as Array<{ spec?: {
      pointerAddress?: number;
      pointeeOffset?: number;
      pointerOffsets?: number[];
      size: number;
    } }>;
    expect(plan[0].spec).toMatchObject({
      pointerAddress: 0x20007000,
      pointerOffsets: [8, 4],
      size: 4,
    });
    expect(plan[0].spec?.pointeeOffset).toBeUndefined();
    expect(plan[1].spec).toMatchObject({
      pointerAddress: 0x20007000,
      pointerOffsets: [8, 20],
      size: 4,
    });

    const readResult = await backend.execute({
      cmd: 'readFastDataSampling',
      specs: plan.map(item => item.spec!).filter(Boolean) as any,
    });

    expect(readResult.ok).toBe(true);
    if (!readResult.ok) throw new Error(readResult.error);
    expect(readResult.data).toEqual([
      expect.objectContaining({
        expression: 'chassis.chassis_motor[0].target_velocity',
        address: 0x20002004,
        display: '1.250000',
      }),
      expect.objectContaining({
        expression: 'chassis.chassis_motor[0].message.out_velocity',
        address: 0x20002014,
        display: '2.500000',
      }),
    ]);
  });

  it('samples a scalar field through a global struct pointer', async () => {
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
          fields: [
            { name: 'message', typeOffset: 'message-type', byteOffset: 4 },
            { name: 'target_position', typeOffset: 'float-type', byteOffset: 12 },
          ],
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
      if (address === 0x2000100c) return Uint8Array.from([0x00, 0x00, 0x20, 0x40]);
      return null;
    };

    const planResult = await backend.execute({
      cmd: 'prepareFastDataSampling',
      expressions: ['down_yaw.target_position', 'down_yaw.message.out_velocity', 'down_yaw.message.out_velociti'],
    });

    expect(planResult.ok).toBe(true);
    if (!planResult.ok) throw new Error(planResult.error);
    const plan = planResult.data as Array<{ spec?: { expression: string; address: number; pointerAddress?: number; pointeeOffset?: number; size: number } }>;
    expect(plan[0].spec).toMatchObject({ pointerAddress: 0x2000721c, pointeeOffset: 12, size: 4 });
    expect(plan[1].spec).toMatchObject({ pointerAddress: 0x2000721c, pointeeOffset: 12, size: 4 });
    expect(plan[2].spec).toBeUndefined();

    const readResult = await backend.execute({ cmd: 'readFastDataSampling', specs: [plan[1].spec!] });

    expect(readResult.ok).toBe(true);
    if (!readResult.ok) throw new Error(readResult.error);
    expect(readResult.data).toEqual([
      expect.objectContaining({ expression: 'down_yaw.message.out_velocity', address: 0x2000100c, display: '2.500000' }),
    ]);
  });

  it('awaits pointer children before returning a Watch value', async () => {
    const backend = new OzoneBackend();
    const internal = backend as unknown as BackendInternals;
    internal.symbols = [{ name: 'down_yaw', address: 0x2000721c, size: 4 }];
    internal.dwarfInfo = {
      varToType: new Map([['down_yaw', 'pointer-type']]),
      typeDefs: new Map([
        ['pointer-type', { name: 'Motor_t*', byteSize: 4, kind: 'pointer', typeOffset: 'motor-type' }],
        ['motor-type', {
          name: 'Motor_t',
          byteSize: 4,
          kind: 'struct',
          fields: [{ name: 'yaw', typeOffset: 'float-type', byteOffset: 0 }],
        }],
        ['float-type', { name: 'float', byteSize: 4, kind: 'base', encoding: 'float' }],
      ]),
    };
    internal.targetReadMemory = async address => {
      if (address === 0x2000721c) return Uint8Array.from([0x00, 0x10, 0x00, 0x20]);
      if (address === 0x20001000) return Uint8Array.from([0x00, 0x00, 0x80, 0x3f]);
      return null;
    };

    const result = await backend.execute({ cmd: 'evaluateExpression', expression: 'down_yaw', force: true });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    const value = result.data as { children?: unknown; display: string };
    expect(value.display).toBe('0x20001000 (536875008)');
    expect(value.children).toEqual([
      expect.objectContaining({ expression: 'yaw', display: '1.000000' }),
    ]);
  });

  it('does not advertise children for a null struct pointer', async () => {
    const backend = new OzoneBackend();
    const internal = backend as unknown as BackendInternals;
    internal.symbols = [{ name: 'ina226_ins', address: 0x200065e0, size: 4 }];
    internal.dwarfInfo = {
      varToType: new Map([['ina226_ins', 'pointer-type']]),
      typeDefs: new Map([
        ['pointer-type', { name: 'Ina226Instance_s*', byteSize: 4, kind: 'pointer', typeOffset: 'struct-type' }],
        ['struct-type', {
          name: 'Ina226Instance_s',
          byteSize: 4,
          kind: 'struct',
          fields: [{ name: 'init_status', typeOffset: 'uint8-type', byteOffset: 0 }],
        }],
        ['uint8-type', { name: 'uint8_t', byteSize: 1, kind: 'base', encoding: 'unsigned' }],
      ]),
    };
    internal.targetReadMemory = async address => address === 0x200065e0
      ? Uint8Array.from([0, 0, 0, 0])
      : null;

    const result = await backend.execute({ cmd: 'evaluateExpression', expression: 'ina226_ins', force: true });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    expect(result.data).toEqual(expect.objectContaining({
      value: 0,
      display: '0x00000000 (0)',
      hasChildren: false,
      children: undefined,
    }));
  });

  it('keeps collapsed pointer Watch values shallow until their expression is expanded', async () => {
    const backend = new OzoneBackend();
    const internal = backend as unknown as BackendInternals;
    const reads: number[] = [];
    internal.symbols = [{ name: 'down_yaw', address: 0x2000721c, size: 4 }];
    internal.dwarfInfo = {
      varToType: new Map([['down_yaw', 'pointer-type']]),
      typeDefs: new Map([
        ['pointer-type', { name: 'Motor_t*', byteSize: 4, kind: 'pointer', typeOffset: 'motor-type' }],
        ['motor-type', {
          name: 'Motor_t',
          byteSize: 4,
          kind: 'struct',
          fields: [{ name: 'yaw', typeOffset: 'float-type', byteOffset: 0 }],
        }],
        ['float-type', { name: 'float', byteSize: 4, kind: 'base', encoding: 'float' }],
      ]),
    };
    internal.targetReadMemory = async address => {
      reads.push(address);
      if (address === 0x2000721c) return Uint8Array.from([0x00, 0x10, 0x00, 0x20]);
      if (address === 0x20001000) return Uint8Array.from([0x00, 0x00, 0x80, 0x3f]);
      return null;
    };

    const collapsed = await backend.execute({
      cmd: 'evaluateExpression',
      expression: 'down_yaw',
      force: true,
      expandedExpressions: [],
    });

    expect(collapsed.ok).toBe(true);
    if (!collapsed.ok) throw new Error(collapsed.error);
    expect(collapsed.data).toEqual(expect.objectContaining({ hasChildren: true, children: undefined }));
    expect(reads).toEqual([0x2000721c]);

    reads.length = 0;
    const expanded = await backend.execute({
      cmd: 'evaluateExpression',
      expression: 'down_yaw',
      force: true,
      expandedExpressions: ['down_yaw'],
    });

    expect(expanded.ok).toBe(true);
    if (!expanded.ok) throw new Error(expanded.error);
    expect(expanded.data).toEqual(expect.objectContaining({
      hasChildren: true,
      children: [expect.objectContaining({ expression: 'yaw', display: '1.000000' })],
    }));
    expect(reads).toEqual([0x2000721c, 0x20001000]);
  });

  it('does not chase nested pointer children unless that exact Watch path is expanded', async () => {
    const backend = new OzoneBackend();
    const internal = backend as unknown as BackendInternals;
    const reads: number[] = [];
    internal.symbols = [{ name: 'root', address: 0x20000000, size: 4 }];
    internal.dwarfInfo = {
      varToType: new Map([['root', 'root-pointer']]),
      typeDefs: new Map([
        ['root-pointer', { name: 'Root_t*', byteSize: 4, kind: 'pointer', typeOffset: 'root-struct' }],
        ['root-struct', {
          name: 'Root_t', byteSize: 4, kind: 'struct',
          fields: [{ name: 'next', typeOffset: 'next-pointer', byteOffset: 0 }],
        }],
        ['next-pointer', { name: 'Next_t*', byteSize: 4, kind: 'pointer', typeOffset: 'next-struct' }],
        ['next-struct', {
          name: 'Next_t', byteSize: 4, kind: 'struct',
          fields: [{ name: 'value', typeOffset: 'float-type', byteOffset: 0 }],
        }],
        ['float-type', { name: 'float', byteSize: 4, kind: 'base', encoding: 'float' }],
      ]),
    };
    internal.targetReadMemory = async address => {
      reads.push(address);
      if (address === 0x20000000) return Uint8Array.from([0x00, 0x10, 0x00, 0x20]);
      if (address === 0x20001000) return Uint8Array.from([0x00, 0x20, 0x00, 0x20]);
      if (address === 0x20002000) return Uint8Array.from([0x00, 0x00, 0x00, 0x40]);
      return null;
    };

    const result = await backend.execute({
      cmd: 'evaluateExpression', expression: 'root', force: true, expandedExpressions: ['root'],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    expect(result.data).toEqual(expect.objectContaining({
      children: [expect.objectContaining({ expression: 'next', hasChildren: true, children: undefined })],
    }));
    expect(reads).toEqual([0x20000000, 0x20001000]);
  });

  it('expands struct pointers stored in a pointer array', async () => {
    const backend = new OzoneBackend();
    const internal = backend as unknown as BackendInternals;
    internal.symbols = [{ name: 'chassis', address: 0x20007000, size: 4 }];
    internal.dwarfInfo = {
      varToType: new Map([['chassis', 'chassis-pointer-type']]),
      typeDefs: new Map([
        ['chassis-pointer-type', { name: 'Chassis_t*', byteSize: 4, kind: 'pointer', typeOffset: 'chassis-type' }],
        ['chassis-type', {
          name: 'Chassis_t',
          byteSize: 8,
          kind: 'struct',
          fields: [{ name: 'chassis_motor', typeOffset: 'motor-array-type', byteOffset: 0 }],
        }],
        ['motor-array-type', { name: 'Motor_t*[2]', byteSize: 8, kind: 'array', typeOffset: 'motor-pointer-type', arrayCount: 2 }],
        ['motor-pointer-type', { name: 'Motor_t*', byteSize: 4, kind: 'pointer', typeOffset: 'motor-type' }],
        ['motor-type', {
          name: 'Motor_t',
          byteSize: 4,
          kind: 'struct',
          fields: [{ name: 'velocity', typeOffset: 'float-type', byteOffset: 0 }],
        }],
        ['float-type', { name: 'float', byteSize: 4, kind: 'base', encoding: 'float' }],
      ]),
    };
    internal.targetReadMemory = async address => {
      if (address === 0x20007000) return Uint8Array.from([0x00, 0x10, 0x00, 0x20]);
      if (address === 0x20001000) return Uint8Array.from([0x00, 0x20, 0x00, 0x20, 0x00, 0x30, 0x00, 0x20]);
      if (address === 0x20002000) return Uint8Array.from([0x00, 0x00, 0x80, 0x3f]);
      if (address === 0x20003000) return Uint8Array.from([0x00, 0x00, 0x00, 0x40]);
      return null;
    };

    const result = await backend.execute({ cmd: 'evaluateExpression', expression: 'chassis', force: true });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    const value = result.data as { children?: Array<{ children?: Array<{ children?: unknown }> }> };
    expect(value.children?.[0]?.children?.[0]).toEqual(expect.objectContaining({
      expression: '[0]',
      display: '0x20002000',
      children: [expect.objectContaining({ expression: 'velocity', display: '1.000000' })],
    }));
    expect(value.children?.[0]?.children?.[1]).toEqual(expect.objectContaining({
      expression: '[1]',
      display: '0x20003000',
      children: [expect.objectContaining({ expression: 'velocity', display: '2.000000' })],
    }));
  });

  it('writes a floating-point child value using its declared type', async () => {
    const backend = new OzoneBackend();
    const internal = backend as any;
    const writes: Array<{ address: number; bytes: number[] }> = [];
    internal.targetIsHalted = async () => false;
    internal.ensureHalted = async () => true;
    internal.targetWriteMemory = async (address: number, bytes: Uint8Array) => {
      writes.push({ address, bytes: Array.from(bytes) });
      return true;
    };
    internal.targetRun = async () => true;

    const result = await backend.execute({
      cmd: 'setWatchValue',
      expression: 'down_yaw.angle_pid.kp',
      value: 1,
      address: 0x20001020,
      typeName: 'float',
    });

    expect(result.ok).toBe(true);
    expect(writes).toEqual([{ address: 0x20001020, bytes: [0, 0, 128, 63] }]);
  });

  it('evaluates a scalar through a nested pointer member chain', async () => {
    const backend = new OzoneBackend();
    const internal = backend as unknown as BackendInternals;
    internal.symbols = [{ name: 'pitch', address: 0x20007000, size: 4 }];
    internal.dwarfInfo = {
      varToType: new Map([['pitch', 'motor-pointer']]),
      typeDefs: new Map([
        ['motor-pointer', { name: 'DmMotorInstance_s*', byteSize: 4, kind: 'pointer', typeOffset: 'motor-type' }],
        ['motor-type', {
          name: 'DmMotorInstance_s', byteSize: 4, kind: 'struct',
          fields: [{ name: 'angle_pid', typeOffset: 'pid-pointer', byteOffset: 0 }],
        }],
        ['pid-pointer', { name: 'PidInstance_s*', byteSize: 4, kind: 'pointer', typeOffset: 'pid-type' }],
        ['pid-type', {
          name: 'PidInstance_s', byteSize: 4, kind: 'struct',
          fields: [{ name: 'kp', typeOffset: 'float-type', byteOffset: 0 }],
        }],
        ['float-type', { name: 'float', byteSize: 4, kind: 'base', encoding: 'float' }],
      ]),
    };
    internal.targetReadMemory = async address => {
      if (address === 0x20007000) return Uint8Array.from([0x00, 0x10, 0x00, 0x20]);
      if (address === 0x20001000) return Uint8Array.from([0x00, 0x20, 0x00, 0x20]);
      if (address === 0x20002000) return Uint8Array.from([0x00, 0x00, 0xA0, 0x3F]);
      return null;
    };

    const result = await backend.execute({
      cmd: 'evaluateExpression', expression: 'pitch->angle_pid->kp', force: true,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    expect(result.data).toEqual(expect.objectContaining({
      expression: 'kp', display: '1.250000', address: 0x20002000, typeName: 'float',
    }));
  });
});
