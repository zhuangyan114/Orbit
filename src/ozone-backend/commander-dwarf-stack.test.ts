import { describe, expect, it, vi } from 'vitest';
import { OzoneBackend } from './commander';
import { DwarfCallFrameInfo, DwarfInfo, DwarfTypeInfo, SymbolInfo } from './jlink-symbols';
import { Variable } from './types';

function putU32(memory: Map<number, number>, address: number, value: number) {
  for (let index = 0; index < 4; index++) memory.set(address + index, (value >>> (index * 8)) & 0xFF);
}

function makeBackend(currentFrame: 'C' | 'C-leaf' | 'B' | 'A' = 'C') {
  const backend = new OzoneBackend() as any;
  const memory = new Map<number, number>();
  const currentRegisters = new Map<number, number>();
  for (let index = 0; index <= 16; index++) currentRegisters.set(index, 0);
  const current = currentFrame === 'C'
    ? { r7: 0x20000FF0, sp: 0x20000FF0, lr: 0x0800020D, pc: 0x08000108 }
    : currentFrame === 'C-leaf'
      ? { r7: 0x20001020, sp: 0x20001020, lr: 0x0800020D, pc: 0x08000108 }
    : currentFrame === 'B'
      ? { r7: 0x20001020, sp: 0x20001020, lr: 0x0800030D, pc: 0x08000208 }
      : { r7: 0x20001030, sp: 0x20001030, lr: 0xFFFFFFF9, pc: 0x08000308 };
  currentRegisters.set(7, current.r7);
  currentRegisters.set(13, current.sp);
  currentRegisters.set(14, current.lr);
  currentRegisters.set(15, current.pc);

  putU32(memory, 0x20001018, 0x20001020);
  putU32(memory, 0x2000101C, 0x0800020D);
  putU32(memory, 0x20001028, 0x20001030);
  putU32(memory, 0x2000102C, 0x0800030D);
  putU32(memory, 0x20001038, 0);
  putU32(memory, 0x2000103C, 0xFFFFFFF9);

  putU32(memory, 0x20001014, 33);
  putU32(memory, 0x20001024, 22);
  putU32(memory, 0x20001034, 11);
  putU32(memory, 0x20000FF8, 0x11223344);
  putU32(memory, 0x20000FFC, 0x55667788);
  putU32(memory, 0x20001000, 3);
  putU32(memory, 0x20001004, 4);
  putU32(memory, 0x20001008, 5);
  putU32(memory, 0x20000FF0, 0x20000CFC);
  putU32(memory, 0x20000FE8, 0x20002100);
  putU32(memory, 0x20000FE4, 0);
  putU32(memory, 0x20002100, 7);
  putU32(memory, 0x20002104, 9);
  memory.set(0x20000FEE, 0x34);
  memory.set(0x20000FEF, 0x12);

  const baseType: DwarfTypeInfo = { name: 'int', byteSize: 4, kind: 'base', encoding: '5 (signed)' };
  const typeDefs = new Map<string, DwarfTypeInfo>([
    ['0x10', baseType],
    ['0x11', { name: 'uint16_t', byteSize: 2, kind: 'base', encoding: '7 (unsigned)' }],
    ['0x20', {
      name: 'Pair', byteSize: 8, kind: 'struct',
      fields: [
        { name: 'first', typeOffset: '0x10', byteOffset: 0 },
        { name: 'second', typeOffset: '0x10', byteOffset: 4 },
      ],
    }],
    ['0x30', { name: '', byteSize: 0, kind: 'array', typeOffset: '0x10', arrayCount: 3, arrayLowerBound: 0 }],
    ['0x40', { name: '', byteSize: 8, kind: 'pointer', typeOffset: '0x10' }],
    ['0x41', { name: '', byteSize: 4, kind: 'pointer', typeOffset: '0x20' }],
  ]);
  const frameRows: DwarfCallFrameInfo[] = [0x08000100, 0x08000200, 0x08000300].map((start, index) => ({
    start, end: start + 0x20,
    rows: [{
      pc: start,
      cfaRegister: 7,
      cfaOffset: index === 0 ? 48 : 16,
      registerRules: new Map([
        [7, { kind: 'cfaOffset' as const, value: -8 }],
        [14, { kind: 'cfaOffset' as const, value: -4 }],
      ]),
    }],
  }));
  if (currentFrame === 'C-leaf') {
    frameRows[0].rows[0] = {
      pc: 0x08000100,
      cfaRegister: 13,
      cfaOffset: 0,
      registerRules: new Map([
        [14, { kind: 'undefined' as const }],
      ]),
    };
  }
  const makeSubprogram = (name: string, start: number, localName: string) => ({
    name,
    ranges: [{ start, end: start + 0x20 }],
    frameBase: { expression: 'DW_OP_call_frame_cfa' },
    variables: [{
      name: localName, typeOffset: '0x10',
      location: { expression: 'DW_OP_fbreg: -12' }, parameter: false,
    }],
    children: [],
  });
  const dwarfInfo: DwarfInfo = {
    varToType: new Map([['global_only', '0x10']]),
    typeDefs,
    subprograms: [
      {
        ...makeSubprogram('C', 0x08000100, 'c_local'),
        variables: [
          { name: 'c_local', typeOffset: '0x10', location: { expression: 'DW_OP_fbreg: -12' }, parameter: false },
          { name: 'c_array', typeOffset: '0x30', location: { expression: 'DW_OP_fbreg: -32' }, parameter: false },
          { name: 'c_struct', typeOffset: '0x20', location: { expression: 'DW_OP_fbreg: -40' }, parameter: false },
          { name: 'optimized', typeOffset: '0x10', parameter: false },
          { name: 'unavailable', typeOffset: '0x10', location: { expression: 'DW_OP_piece: 4' }, parameter: false },
          { name: 'uninitialized', typeOffset: '0x10', location: { expression: 'DW_OP_fbreg: -44; DW_OP_GNU_uninit' }, parameter: false },
          { name: 'pointer32', typeOffset: '0x40', location: { expression: 'DW_OP_fbreg: -48' }, parameter: false },
          { name: 'structPointer', typeOffset: '0x41', location: { expression: 'DW_OP_fbreg: -56' }, parameter: false },
          { name: 'nullStructPointer', typeOffset: '0x41', location: { expression: 'DW_OP_fbreg: -60' }, parameter: false },
          { name: 'unsigned16', typeOffset: '0x11', location: { expression: 'DW_OP_fbreg: -50' }, parameter: false },
        ],
      },
      {
        ...makeSubprogram('B', 0x08000200, 'b_local'),
        variables: [
          { name: 'b_local', typeOffset: '0x10', location: { expression: 'DW_OP_fbreg: -12' }, parameter: false },
          { name: 'caller_r0', typeOffset: '0x10', location: { expression: 'DW_OP_reg0' }, parameter: false },
        ],
      },
      makeSubprogram('A', 0x08000300, 'a_local'),
    ],
    locationLists: new Map(),
    callFrames: frameRows,
  };
  const symbols = [
    { name: 'C', address: 0x08000100, size: 0x20, type: 'T' },
    { name: 'B', address: 0x08000200, size: 0x20, type: 'T' },
    { name: 'A', address: 0x08000300, size: 0x20, type: 'T' },
    { name: 'global_only', address: 0x20002000, size: 4, type: 'B' },
  ] satisfies SymbolInfo[];

  backend.dwarfInfo = dwarfInfo;
  backend.symbols = symbols;
  backend.lineEntries = [
    { address: 0x08000100, file: 'abc.c', line: 10 },
    { address: 0x08000200, file: 'abc.c', line: 20 },
    { address: 0x08000300, file: 'abc.c', line: 30 },
  ];
  backend.targetIsHalted = vi.fn(async () => true);
  backend.readRegisterValue = vi.fn(async (index: number) => currentRegisters.get(index) ?? null);
  backend.targetReadMemory = vi.fn(async (address: number, size: number) => {
    const bytes = new Uint8Array(size);
    for (let index = 0; index < size; index++) {
      const value = memory.get(address + index);
      if (value === undefined) return null;
      bytes[index] = value;
    }
    return bytes;
  });
  return backend as OzoneBackend;
}

describe('DWARF locals and Cortex-M stack unwinding', () => {
  it('returns youngest-to-oldest C, B, A frames and stops at EXC_RETURN', async () => {
    const backend = makeBackend();
    const result = await backend.execute({ cmd: 'getCallStack' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect((result.data as Array<{ function: string }>).map(frame => frame.function)).toEqual(['C', 'B', 'A']);
  });

  it('unwinds a frameless leaf C through its live LR before using caller CFI', async () => {
    const result = await makeBackend('C-leaf').execute({ cmd: 'getCallStack' });
    expect(result.ok && (result.data as Array<{ function: string }>).map(frame => frame.function)).toEqual(['C', 'B', 'A']);
  });

  it('adds one frame after stepping into C and removes it after stepping out', async () => {
    const before = await makeBackend('B').execute({ cmd: 'getCallStack' });
    const inside = await makeBackend('C').execute({ cmd: 'getCallStack' });
    const after = await makeBackend('B').execute({ cmd: 'getCallStack' });
    expect(before.ok && (before.data as Array<{ function: string }>).map(frame => frame.function)).toEqual(['B', 'A']);
    expect(inside.ok && (inside.data as Array<{ function: string }>).map(frame => frame.function)).toEqual(['C', 'B', 'A']);
    expect(after.ok && (after.data as Array<{ function: string }>).map(frame => frame.function)).toEqual(['B', 'A']);
  });

  it('uses each frame CFA for locals and never mixes ELF globals into Local', async () => {
    const backend = makeBackend();
    await backend.execute({ cmd: 'getCallStack' });
    const locals = [];
    for (const frame of [1, 2, 3]) {
      const result = await backend.execute({ cmd: 'getLocals', frame });
      expect(result.ok).toBe(true);
      locals.push(result.ok ? result.data as Variable[] : []);
    }
    expect(locals[0].map(variable => variable.name)).toEqual([
      'c_local', 'c_array', 'c_struct', 'optimized', 'unavailable', 'uninitialized',
      'pointer32', 'structPointer', 'nullStructPointer', 'unsigned16',
    ]);
    expect(locals[0].find(variable => variable.name === 'c_local')?.value).toBe('33');
    expect(locals[1]).toMatchObject([
      { name: 'b_local', value: '22' },
      { name: 'caller_r0', value: '<unavailable>' },
    ]);
    expect(locals[2]).toMatchObject([{ name: 'a_local', value: '11' }]);
    expect(locals.flat().some(variable => variable.name === 'global_only')).toBe(false);
    expect(locals[0].find(variable => variable.name === 'optimized')?.value).toBe('<optimized out>');
    expect(locals[0].find(variable => variable.name === 'unavailable')?.value).toBe('<unavailable>');
    expect(locals[0].find(variable => variable.name === 'uninitialized')?.value).toBe('<uninitialized>');
    expect(locals[0].find(variable => variable.name === 'pointer32')?.value).toBe('0x20000CFC');
    expect(locals[0].find(variable => variable.name === 'nullStructPointer')).toMatchObject({
      value: '0x00000000',
      children: undefined,
    });
    expect(locals[0].find(variable => variable.name === 'unsigned16')?.value).toBe('4660');
  });

  it('returns arrays and structures as expandable children, not uint64 values', async () => {
    const backend = makeBackend();
    await backend.execute({ cmd: 'getCallStack' });
    const result = await backend.execute({ cmd: 'getLocals', frame: 1 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const variables = result.data as Variable[];
    const array = variables.find(variable => variable.name === 'c_array');
    const struct = variables.find(variable => variable.name === 'c_struct');
    const structPointer = variables.find(variable => variable.name === 'structPointer');
    expect(array?.value).toBe('[3]');
    expect(array?.children?.map(child => child.name)).toEqual(['[0]', '[1]', '[2]']);
    expect(struct?.value).toBe('{...}');
    expect(struct?.children?.map(child => child.name)).toEqual(['first', 'second']);
    expect(structPointer).toMatchObject({
      value: '0x20002100',
      address: 0x20002100,
      children: [
        { name: 'first', value: '7' },
        { name: 'second', value: '9' },
      ],
    });
  });
});
