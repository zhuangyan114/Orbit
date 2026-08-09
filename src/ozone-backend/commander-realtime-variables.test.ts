import { describe, expect, it } from 'vitest';
import { OzoneBackend } from './commander';

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

function formatScalar(backend: OzoneBackend, raw: number[], byteSize: number, info: Record<string, unknown>) {
  return (backend as any).formatScalarValue(Uint8Array.from(raw), byteSize, info) as {
    value: number | string;
    display: string;
    hex: string;
    exactValue?: string;
    numericValueExact?: boolean;
  };
}

describe('OzoneBackend realtime variables', () => {
  it('caches planner output by ordered expressions and symbol/session generations', async () => {
    const backend = new OzoneBackend();
    const internal = backend as unknown as BackendInternals & { symbolGeneration: number; sessionGeneration: number };
    internal.symbols = [
      { name: 'a', address: 0x20000100, size: 4 },
      { name: 'b', address: 0x20000104, size: 4 },
    ];
    internal.dwarfInfo = { varToType: new Map(), typeDefs: new Map() };

    const first = await backend.execute({ cmd: 'prepareFastDataSampling', expressions: ['a', 'b'] });
    const second = await backend.execute({ cmd: 'prepareFastDataSampling', expressions: ['a', 'b'] });
    const reordered = await backend.execute({ cmd: 'prepareFastDataSampling', expressions: ['b', 'a'] });
    expect(first).toEqual(second);
    expect(reordered).not.toEqual(first);

    const beforeGeneration = await backend.execute({ cmd: 'getPerformanceDiagnostics' });
    expect(beforeGeneration).toMatchObject({
      ok: true,
      data: { planner: { planCacheHit: 1, planCacheMiss: 2 } },
    });
    internal.symbolGeneration++;
    const afterElfReload = await backend.execute({ cmd: 'prepareFastDataSampling', expressions: ['a', 'b'] });
    expect(afterElfReload).toEqual(first);
    internal.sessionGeneration++;
    await backend.execute({ cmd: 'prepareFastDataSampling', expressions: ['a', 'b'] });
    const afterSessionReplacement = await backend.execute({ cmd: 'getPerformanceDiagnostics' });
    expect(afterSessionReplacement).toMatchObject({
      ok: true,
      data: { planner: { planCacheHit: 1, planCacheMiss: 4 } },
    });
  });

  it('keeps rejected planner entries rejected and never caches target values', async () => {
    const backend = new OzoneBackend();
    const internal = backend as unknown as BackendInternals;
    internal.symbols = [{ name: 'root', address: 0x20000100, size: 32 }];
    internal.dwarfInfo = { varToType: new Map(), typeDefs: new Map() };

    const first = await backend.execute({ cmd: 'prepareFastDataSampling', expressions: ['root'] });
    expect(first).toMatchObject({ ok: true, data: [{ expression: 'root', error: expect.any(String) }] });
    if (!first.ok) throw new Error(first.error);
    (first.data as any)[0].expression = 'mutated';
    const second = await backend.execute({ cmd: 'prepareFastDataSampling', expressions: ['root'] });
    expect(second).toMatchObject({ ok: true, data: [{ expression: 'root', error: expect.any(String) }] });
    expect(second).not.toMatchObject({ data: [{ value: expect.anything() }] });
  });

  it('formats enum values with the integer and enumerator name', () => {
    const value = formatScalar(new OzoneBackend(), [2, 0, 0, 0], 4, {
      kind: 'enum',
      name: 'Dap06Mode',
      enumerators: [{ name: 'DAP06_RUN', value: '2' }],
    });

    expect(value).toMatchObject({ value: 2, display: '0x00000002 (2, DAP06_RUN)' });
  });

  it('preserves enum, boolean, and character formatting through fast sampling', async () => {
    const backend = new OzoneBackend();
    const internal = backend as unknown as BackendInternals;
    internal.symbols = [
      { name: 'mode', address: 0x20000100, size: 4 },
      { name: 'enabled', address: 0x20000104, size: 1 },
      { name: 'letter', address: 0x20000105, size: 1 },
    ];
    internal.dwarfInfo = {
      varToType: new Map([
        ['mode', 'mode-type'],
        ['enabled', 'bool-type'],
        ['letter', 'char-type'],
      ]),
      typeDefs: new Map([
        ['mode-type', { name: 'Mode', byteSize: 4, kind: 'enum', enumerators: [{ name: 'MODE_RUN', value: '2' }] }],
        ['bool-type', { name: '_Bool', byteSize: 1, kind: 'base', encoding: 'boolean' }],
        ['char-type', { name: 'char', byteSize: 1, kind: 'base', encoding: 'signed char' }],
      ]),
    };
    internal.targetReadMemory = async address => {
      if (address === 0x20000100) return Uint8Array.from([2, 0, 0, 0]);
      if (address === 0x20000104) return Uint8Array.from([1]);
      if (address === 0x20000105) return Uint8Array.from([0x41]);
      return null;
    };

    const planned = await backend.execute({ cmd: 'prepareFastDataSampling', expressions: ['mode', 'enabled', 'letter'] });
    expect(planned.ok).toBe(true);
    if (!planned.ok) throw new Error(planned.error);
    const specs = (planned.data as Array<{ spec?: any }>).map(item => item.spec).filter(Boolean);
    const sampled = await backend.execute({ cmd: 'readFastDataSampling', specs, priority: 'watch' });

    expect(sampled.ok).toBe(true);
    if (!sampled.ok) throw new Error(sampled.error);
    expect(sampled.data).toEqual([
      expect.objectContaining({ expression: 'mode', display: '0x00000002 (2, MODE_RUN)' }),
      expect.objectContaining({ expression: 'enabled', display: '0x01 (1, true)' }),
      expect.objectContaining({ expression: 'letter', display: "'A' (65, 0x41)" }),
    ]);
  });

  it('merges adjacent fast-sampling reads without changing expression order', async () => {
    const backend = new OzoneBackend();
    const batches: Array<Array<{ address: number; size: number }>> = [];
    (backend as any).sessionTarget = {
      async readMemoryBatch(reads: Array<{ address: number; size: number }>) {
        batches.push(reads);
        return {
          ok: true,
          data: {
            reads: reads.map(read => ({
              address: read.address,
              bytes: Uint8Array.from([1, 0, 0, 0, 2, 0, 0, 0, 3, 0, 0, 0].slice(0, read.size)),
            })),
          },
        };
      },
    };

    const sampled = await backend.execute({
      cmd: 'readFastDataSampling',
      priority: 'watch',
      specs: [
        { expression: 'a', address: 0x20000004, size: 4, format: { kind: 'base', encoding: 'unsigned' } },
        { expression: 'c', address: 0x20000000, size: 4, format: { kind: 'base', encoding: 'unsigned' } },
        { expression: 'b', address: 0x20000008, size: 4, format: { kind: 'base', encoding: 'unsigned' } },
      ],
    });

    expect(batches).toEqual([[{ address: 0x20000000, size: 12 }]]);
    expect(sampled).toMatchObject({
      ok: true,
      data: [
        { expression: 'a', value: 2 },
        { expression: 'c', value: 1 },
        { expression: 'b', value: 3 },
      ],
    });
  });

  it('keeps int64 and uint64 values exact beyond the JavaScript safe range', () => {
    const signed = formatScalar(new OzoneBackend(), [1, 0, 0, 0, 0, 0, 0x00, 0x80], 8, {
      kind: 'base', name: 'int64_t', encoding: 'signed',
    });
    const unsigned = formatScalar(new OzoneBackend(), [0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF], 8, {
      kind: 'base', name: 'uint64_t', encoding: 'unsigned',
    });

    expect(signed).toMatchObject({
      value: '-9223372036854775807',
      exactValue: '-9223372036854775807',
      numericValueExact: false,
      hex: '0x8000000000000001',
    });
    expect(unsigned).toMatchObject({
      value: '18446744073709551615',
      exactValue: '18446744073709551615',
      numericValueExact: false,
      hex: '0xFFFFFFFFFFFFFFFF',
    });
  });

  it('preserves exact 64-bit metadata through evaluateExpression', async () => {
    const backend = new OzoneBackend();
    const internal = backend as unknown as BackendInternals;
    internal.symbols = [{ name: 'g_u64', address: 0x20000100, size: 8 }];
    internal.dwarfInfo = {
      varToType: new Map([['g_u64', 'u64-type']]),
      typeDefs: new Map([
        ['u64-type', { name: 'uint64_t', byteSize: 8, kind: 'base', encoding: 'unsigned' }],
      ]),
    };
    internal.targetReadMemory = async () => Uint8Array.from([0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF]);

    const result = await backend.execute({ cmd: 'evaluateExpression', expression: 'g_u64', force: true });

    expect(result).toMatchObject({
      ok: true,
      data: {
        value: '18446744073709551615',
        exactValue: '18446744073709551615',
        numericValueExact: false,
      },
    });
  });

  it('reports a TCB runtime counter from its declared uint32_t bytes without synthetic wrap extension', async () => {
    const backend = new OzoneBackend();
    const internal = backend as unknown as BackendInternals;
    const tcbAddress = 0x20000740;
    const runtimeCounterOffset = 88;
    let runtimeCounter = 0xF0000000;
    internal.symbols = [];
    internal.dwarfInfo = {
      varToType: new Map(),
      typeDefs: new Map([
        ['tcb-type', {
          name: 'TCB_t', byteSize: 100, kind: 'struct', fields: [
            { name: 'ulRunTimeCounter', typeOffset: 'u32-type', byteOffset: runtimeCounterOffset },
          ],
        }],
        ['u32-type', { name: 'uint32_t', byteSize: 4, kind: 'base', encoding: 'unsigned' }],
      ]),
    };
    internal.targetReadMemory = async (address, size) => {
      if (address !== tcbAddress || size !== 100) return null;
      const bytes = new Uint8Array(size);
      new DataView(bytes.buffer).setUint32(runtimeCounterOffset, runtimeCounter, true);
      return bytes;
    };

    const expression = `((TCB_t*)0x${tcbAddress.toString(16)}).ulRunTimeCounter`;
    const beforeWrap = await backend.execute({ cmd: 'evaluateExpression', expression, force: true });
    runtimeCounter = 0x30DF7F6B;
    const afterWrap = await backend.execute({ cmd: 'evaluateExpression', expression, force: true });

    expect(beforeWrap).toMatchObject({
      ok: true,
      data: { value: 0xF0000000, display: '0xF0000000 (4026531840)', hex: '0xF0000000' },
    });
    expect(afterWrap).toMatchObject({
      ok: true,
      data: { value: 0x30DF7F6B, display: '0x30DF7F6B (819953515)', hex: '0x30DF7F6B' },
    });
  });

  it('reports the FreeRTOS runtime total from its declared uint32_t bytes', async () => {
    const backend = new OzoneBackend();
    const internal = backend as unknown as BackendInternals;
    let runtimeTotal = 0xF1234567;
    internal.symbols = [{ name: 'ulTotalRunTime', address: 0x20000100, size: 4 }];
    internal.dwarfInfo = {
      varToType: new Map([['ulTotalRunTime', 'u32-type']]),
      typeDefs: new Map([
        ['u32-type', { name: 'uint32_t', byteSize: 4, kind: 'base', encoding: 'unsigned' }],
      ]),
    };
    internal.targetReadMemory = async (address, size) => {
      if (address !== 0x20000100 || size !== 4) return null;
      const bytes = new Uint8Array(4);
      new DataView(bytes.buffer).setUint32(0, runtimeTotal, true);
      return bytes;
    };

    await backend.execute({ cmd: 'evaluateExpression', expression: 'ulTotalRunTime', force: true });
    runtimeTotal = 0x067F0AC6;
    const result = await backend.execute({ cmd: 'evaluateExpression', expression: 'ulTotalRunTime', force: true });

    expect(result).toMatchObject({
      ok: true,
      data: { value: 0x067F0AC6, display: '0x067F0AC6 (108989126)', hex: '0x067F0AC6' },
    });
  });

  it('formats bool and char with numeric and semantic text', () => {
    const bool = formatScalar(new OzoneBackend(), [1], 1, { kind: 'base', name: '_Bool', encoding: 'boolean' });
    const char = formatScalar(new OzoneBackend(), [0x41], 1, { kind: 'base', name: 'char', encoding: 'signed char' });

    expect(bool.display).toBe('0x01 (1, true)');
    expect(char.display).toBe("'A' (65, 0x41)");
  });

  it('keeps uint8_t numeric instead of classifying it as char', () => {
    const value = formatScalar(new OzoneBackend(), [0xFF], 1, { kind: 'base', name: 'uint8_t', encoding: 'unsigned char' });

    expect(value).toMatchObject({ value: 255, display: '0xFF (255)', hex: '0xFF' });
  });

  it('reads bounded char arrays and UTF-8 text without changing uint8_t arrays', async () => {
    const backend = new OzoneBackend();
    const internal = backend as unknown as BackendInternals;
    const asciiAddress = 0x20000100;
    const utf8Address = 0x20000120;
    const unterminatedAddress = 0x20000140;
    const u8Address = 0x20000160;
    const textPointerAddress = 0x20000180;
    const nullPointerAddress = 0x20000184;
    internal.symbols = [
      { name: 'g_ascii', address: asciiAddress, size: 6 },
      { name: 'g_utf8', address: utf8Address, size: 13 },
      { name: 'g_unterminated', address: unterminatedAddress, size: 4 },
      { name: 'g_u8_array', address: u8Address, size: 4 },
      { name: 'g_text_ptr', address: textPointerAddress, size: 4 },
      { name: 'g_null_ptr', address: nullPointerAddress, size: 4 },
    ];
    internal.dwarfInfo = {
      varToType: new Map([
        ['g_ascii', 'char-array'],
        ['g_utf8', 'utf8-array'],
        ['g_unterminated', 'unterminated-array'],
        ['g_u8_array', 'u8-array'],
      ]),
      typeDefs: new Map([
        ['char-type', { name: 'char', byteSize: 1, kind: 'base', encoding: 'signed char' }],
        ['char-array', { name: 'char[6]', byteSize: 6, kind: 'array', typeOffset: 'char-type', arrayCount: 6 }],
        ['utf8-array', { name: 'char[13]', byteSize: 13, kind: 'array', typeOffset: 'char-type', arrayCount: 13 }],
        ['unterminated-array', { name: 'char[4]', byteSize: 4, kind: 'array', typeOffset: 'char-type', arrayCount: 4 }],
        ['u8-type', { name: 'uint8_t', byteSize: 1, kind: 'base', encoding: 'unsigned char' }],
        ['u8-array', { name: 'uint8_t[4]', byteSize: 4, kind: 'array', typeOffset: 'u8-type', arrayCount: 4 }],
        ['char-pointer', { name: 'char *', byteSize: 4, kind: 'pointer', typeOffset: 'char-type' }],
      ]),
    };
    internal.targetReadMemory = async (address, size) => {
      const bytes = address === asciiAddress
        ? [0x4F, 0x72, 0x62, 0x69, 0x74, 0x00]
        : address === utf8Address
          ? [0xE8, 0xBD, 0xA8, 0xE9, 0x81, 0x93, 0xE8, 0xB0, 0x83, 0xE8, 0xAF, 0x95, 0x00]
          : address === unterminatedAddress
            ? [0x4E, 0x4F, 0x50, 0x21]
            : address === u8Address ? [0x00, 0x7F, 0x80, 0xFF]
              : address === textPointerAddress ? [0x00, 0x01, 0x00, 0x20]
                : address === nullPointerAddress ? [0x00, 0x00, 0x00, 0x00] : [];
      if (address === 0x20000100 && size === 256) return Uint8Array.from([...bytes, ...new Array(250).fill(0)]);
      return bytes.length >= size ? Uint8Array.from(bytes.slice(0, size)) : null;
    };

    const ascii = await backend.execute({ cmd: 'evaluateExpression', expression: 'g_ascii', force: true });
    const utf8 = await backend.execute({ cmd: 'evaluateExpression', expression: 'g_utf8', force: true });
    const unterminated = await backend.execute({ cmd: 'evaluateExpression', expression: 'g_unterminated', force: true });
    const numeric = await backend.execute({ cmd: 'evaluateExpression', expression: 'g_u8_array', force: true, expandedExpressions: ['g_u8_array'] });
    internal.dwarfInfo.varToType.set('g_text_ptr', 'char-pointer');
    internal.dwarfInfo.varToType.set('g_null_ptr', 'char-pointer');
    const textPointer = await backend.execute({ cmd: 'evaluateExpression', expression: 'g_text_ptr', force: true });
    const nullPointer = await backend.execute({ cmd: 'evaluateExpression', expression: 'g_null_ptr', force: true });

    expect(ascii).toMatchObject({ ok: true, data: { display: '"Orbit"' } });
    expect(utf8).toMatchObject({ ok: true, data: { display: '"轨道调试"' } });
    expect(unterminated).toMatchObject({ ok: true, data: { error: expect.stringContaining('unterminated') } });
    expect(textPointer).toMatchObject({ ok: true, data: { display: '"Orbit"' } });
    expect(nullPointer).toMatchObject({ ok: true, data: { display: 'NULL' } });
    expect(numeric).toMatchObject({ ok: true, data: { children: [
      expect.objectContaining({ value: 0 }),
      expect.objectContaining({ value: 127 }),
      expect.objectContaining({ value: 128 }),
      expect.objectContaining({ value: 255 }),
    ] } });
  });

  it('resolves function-pointer addresses to ELF names without calling them', async () => {
    const backend = new OzoneBackend();
    const internal = backend as unknown as BackendInternals;
    const functionPointerType = 'function-pointer';
    internal.symbols = [
      { name: 'g_dap06_function', address: 0x200001A0, size: 4 },
      { name: 'g_dap06_null_function', address: 0x200001A4, size: 4 },
      { name: 'g_dap06_unknown_function', address: 0x200001A8, size: 4 },
      { name: 'dap06_transform', address: 0x08001234, size: 20, type: 'T' },
    ];
    internal.dwarfInfo = {
      varToType: new Map([
        ['g_dap06_function', functionPointerType],
        ['g_dap06_null_function', functionPointerType],
        ['g_dap06_unknown_function', functionPointerType],
      ]),
      typeDefs: new Map([
        [functionPointerType, { name: 'Dap06Function', byteSize: 4, kind: 'pointer', typeOffset: 'function-type' }],
        ['function-type', { name: 'uint32_t (uint32_t)', byteSize: 4, kind: 'subroutine' }],
      ]),
    };
    internal.targetReadMemory = async address => {
      if (address === 0x200001A0) return Uint8Array.from([0x35, 0x12, 0x00, 0x08]);
      if (address === 0x200001A4) return Uint8Array.from([0, 0, 0, 0]);
      if (address === 0x200001A8) return Uint8Array.from([0x01, 0x20, 0x00, 0x08]);
      return null;
    };

    const named = await backend.execute({ cmd: 'evaluateExpression', expression: 'g_dap06_function', force: true });
    const nullFunction = await backend.execute({ cmd: 'evaluateExpression', expression: 'g_dap06_null_function', force: true });
    const unknown = await backend.execute({ cmd: 'evaluateExpression', expression: 'g_dap06_unknown_function', force: true });

    expect(named).toMatchObject({ ok: true, data: { display: expect.stringContaining('dap06_transform'), hex: '0x08001235' } });
    expect(nullFunction).toMatchObject({ ok: true, data: { display: 'NULL' } });
    expect(unknown).toMatchObject({ ok: true, data: { display: expect.stringContaining('<unknown>') } });
  });

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

  it('provides full evaluate names for top-level RTOS array elements', async () => {
    const backend = new OzoneBackend();
    const internal = backend as unknown as BackendInternals;
    const listAddress = 0x200000A8;
    internal.symbols = [{ name: 'pxReadyTasksLists', address: listAddress, size: 40 }];
    internal.dwarfInfo = {
      varToType: new Map([['pxReadyTasksLists', 'ready-lists-type']]),
      typeDefs: new Map([
        ['ready-lists-type', {
          name: 'List_t[2]', byteSize: 40, kind: 'array', typeOffset: 'list-type', arrayCount: 2,
        }],
        ['list-type', {
          name: 'xLIST', byteSize: 20, kind: 'struct',
          fields: [{ name: 'uxNumberOfItems', typeOffset: 'u32-type', byteOffset: 0 }],
        }],
        ['u32-type', { name: 'uint32_t', byteSize: 4, kind: 'base', encoding: 'unsigned' }],
      ]),
    };
    internal.targetReadMemory = async (address, size) => {
      if (address !== listAddress || size !== 40) return null;
      const bytes = new Uint8Array(40);
      bytes[0] = 1;
      return bytes;
    };

    const rootResult = await backend.execute({
      cmd: 'evaluateExpression',
      expression: 'pxReadyTasksLists',
      force: true,
      expandedExpressions: ['pxReadyTasksLists'],
    });

    expect(rootResult.ok).toBe(true);
    if (!rootResult.ok) throw new Error(rootResult.error);
    const root = rootResult.data as any;
    expect(root.children?.[0]).toEqual(expect.objectContaining({
      expression: '[0]',
      evaluateName: 'pxReadyTasksLists[0]',
      hasChildren: true,
      children: undefined,
    }));

    const expandedResult = await backend.execute({
      cmd: 'evaluateExpression',
      expression: 'pxReadyTasksLists',
      force: true,
      expandedExpressions: ['pxReadyTasksLists', 'pxReadyTasksLists[0]'],
    });

    expect(expandedResult.ok).toBe(true);
    if (!expandedResult.ok) throw new Error(expandedResult.error);
    const expandedRoot = expandedResult.data as any;
    expect(expandedRoot.children?.[0]).toEqual(expect.objectContaining({
      evaluateName: 'pxReadyTasksLists[0]',
      children: [expect.objectContaining({
        evaluateName: 'pxReadyTasksLists[0].uxNumberOfItems',
        value: 1,
      })],
    }));
  });

  it('expands unions nested in struct arrays and through a struct pointer', async () => {
    const backend = new OzoneBackend();
    const internal = backend as unknown as BackendInternals;
    const rootAddress = 0x20004000;
    const rootBytes = Uint8Array.from([
      0x34, 0x12, 0xFE, 0xFF, 0x00, 0x00, 0x80, 0x3F,
      0xCD, 0xAB, 0x85, 0xFF, 0xDB, 0x0F, 0x49, 0x40,
      0x08, 0x40, 0x00, 0x20, 0x88, 0x77, 0x66, 0x55,
      0x44, 0x33, 0x22, 0x11,
    ]);
    internal.symbols = [{ name: 'g_dap06_complex', address: rootAddress, size: rootBytes.length }];
    internal.dwarfInfo = {
      varToType: new Map([['g_dap06_complex', 'root-type']]),
      typeDefs: new Map([
        ['root-type', {
          name: 'Dap06Root', byteSize: 28, kind: 'struct', fields: [
            { name: 'leaves', typeOffset: 'leaf-array', byteOffset: 0 },
            { name: 'selected', typeOffset: 'leaf-pointer', byteOffset: 16 },
            { name: 'nested', typeOffset: 'nested-type', byteOffset: 20 },
          ],
        }],
        ['leaf-array', { name: 'Dap06Leaf[2]', byteSize: 16, kind: 'array', typeOffset: 'leaf-type', arrayCount: 2 }],
        ['leaf-pointer', { name: 'Dap06Leaf*', byteSize: 4, kind: 'pointer', typeOffset: 'leaf-type' }],
        ['nested-type', {
          name: 'Dap06Nested', byteSize: 8, kind: 'struct', fields: [
            { name: 'counter', typeOffset: 'u32-type', byteOffset: 0 },
            { name: 'state', typeOffset: 'payload-union', byteOffset: 4 },
          ],
        }],
        ['leaf-type', {
          name: 'Dap06Leaf', byteSize: 8, kind: 'struct', fields: [
            { name: 'id', typeOffset: 'u16-type', byteOffset: 0 },
            { name: 'signed_value', typeOffset: 'i16-type', byteOffset: 2 },
            { name: 'payload', typeOffset: 'payload-union', byteOffset: 4 },
          ],
        }],
        ['payload-union', {
          name: 'Dap06Union', byteSize: 4, kind: 'union', fields: [
            { name: 'raw', typeOffset: 'u32-type', byteOffset: 0 },
            { name: 'as_float', typeOffset: 'float-type', byteOffset: 0 },
            { name: 'bytes', typeOffset: 'byte-array', byteOffset: 0 },
          ],
        }],
        ['byte-array', { name: 'uint8_t[4]', byteSize: 4, kind: 'array', typeOffset: 'u8-type', arrayCount: 4 }],
        ['u8-type', { name: 'uint8_t', byteSize: 1, kind: 'base', encoding: 'unsigned char' }],
        ['u16-type', { name: 'uint16_t', byteSize: 2, kind: 'base', encoding: 'unsigned' }],
        ['i16-type', { name: 'int16_t', byteSize: 2, kind: 'base', encoding: 'signed' }],
        ['u32-type', { name: 'uint32_t', byteSize: 4, kind: 'base', encoding: 'unsigned' }],
        ['float-type', { name: 'float', byteSize: 4, kind: 'base', encoding: 'float' }],
      ]),
    };
    internal.targetReadMemory = async (address, size) => {
      const offset = address - rootAddress;
      if (offset < 0 || offset + size > rootBytes.length) return null;
      return rootBytes.slice(offset, offset + size);
    };

    const result = await backend.execute({
      cmd: 'evaluateExpression', expression: 'g_dap06_complex', force: true,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    const root = result.data as any;
    const secondLeaf = root.children[0].children[1];
    expect(secondLeaf).toEqual(expect.objectContaining({
      evaluateName: 'g_dap06_complex.leaves[1]',
      address: rootAddress + 8,
      hasChildren: true,
    }));
    expect(secondLeaf.children[1]).toEqual(expect.objectContaining({
      evaluateName: 'g_dap06_complex.leaves[1].signed_value',
      value: -123,
    }));
    expect(secondLeaf.children[2]).toEqual(expect.objectContaining({
      evaluateName: 'g_dap06_complex.leaves[1].payload',
      typeName: 'Dap06Union',
      hasChildren: true,
    }));
    expect(secondLeaf.children[2].children).toEqual([
      expect.objectContaining({ expression: 'raw', value: 0x40490FDB }),
      expect.objectContaining({ expression: 'as_float', display: '3.141593' }),
      expect.objectContaining({
        expression: 'bytes',
        children: [
          expect.objectContaining({ expression: '[0]', value: 0xDB }),
          expect.objectContaining({ expression: '[1]', value: 0x0F }),
          expect.objectContaining({ expression: '[2]', value: 0x49 }),
          expect.objectContaining({ expression: '[3]', value: 0x40 }),
        ],
      }),
    ]);
    expect(root.children[1]).toEqual(expect.objectContaining({
      expression: 'selected',
      display: '0x20004008',
      hasChildren: true,
      children: expect.arrayContaining([
        expect.objectContaining({ expression: 'id', value: 0xABCD }),
        expect.objectContaining({ expression: 'payload', hasChildren: true }),
      ]),
    }));
    expect(root.children[2].children[1].children[0]).toEqual(expect.objectContaining({
      evaluateName: 'g_dap06_complex.nested.state.raw',
      value: 0x11223344,
    }));

    const direct = await backend.execute({
      cmd: 'evaluateExpression', expression: 'g_dap06_complex.nested.state.raw', force: true,
    });
    expect(direct).toMatchObject({ ok: true, data: expect.objectContaining({ value: 0x11223344 }) });
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
