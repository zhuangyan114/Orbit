import { describe, expect, it, vi } from 'vitest';
const fixture = vi.hoisted(() => ({ info: '' }));
vi.mock('child_process', () => ({ execFile: vi.fn((_tool: string, args: string[], _options: unknown, callback: Function) =>
  callback(null, args.includes('--dwarf=info') ? fixture.info : '', '')) }));
import { buildSymbolCatalog, parseDwarfTypeInfo } from './jlink-symbols';
import { symbolByteSize, symbolChildren, symbolTypeName } from '../symbols/symbol-catalog';

describe('DWARF browser metadata', () => {
  it('retains compilation source, fixed storage address, global type and multidimensional array layout', async () => {
    fixture.info = `
 <0><0>: Abbrev Number: 1 (DW_TAG_compile_unit)
    <1> DW_AT_name : src/main.c
    <2> DW_AT_comp_dir : D:/firmware
 <1><10>: Abbrev Number: 2 (DW_TAG_base_type)
    <11> DW_AT_name : float
    <12> DW_AT_byte_size : 4
 <1><20>: Abbrev Number: 3 (DW_TAG_array_type)
    <21> DW_AT_type : <0x10>
 <2><25>: Abbrev Number: 4 (DW_TAG_subrange_type)
    <26> DW_AT_upper_bound : 1
 <2><28>: Abbrev Number: 4 (DW_TAG_subrange_type)
    <29> DW_AT_count : 3
 <1><30>: Abbrev Number: 5 (DW_TAG_variable)
    <31> DW_AT_name : matrix
    <32> DW_AT_type : <0x20>
    <33> DW_AT_location : 5 byte block: 3 0 0 0 20 (DW_OP_addr: 20000000)
 <1><40>: Abbrev Number: 6 (DW_TAG_subprogram)
 <2><50>: Abbrev Number: 5 (DW_TAG_variable)
    <51> DW_AT_name : matrix
    <52> DW_AT_type : <0x10>
    <53> DW_AT_location : 2 byte block (DW_OP_fbreg: -4)
 <1><60>: Abbrev Number: 5 (DW_TAG_variable)
    <61> DW_AT_name : speed
    <62> DW_AT_type : <0x10>
 <1><70>: Abbrev Number: 5 (DW_TAG_variable)
    <71> DW_AT_specification : <0x60>
    <72> DW_AT_location : 5 byte block (DW_OP_addr: 20000020)
`;
    const dwarf = await parseDwarfTypeInfo('fixture.elf');
    expect(dwarf.globals).toEqual([
      { name: 'matrix', typeOffset: '0x20', address: 0x20000000, file: 'D:\\firmware\\src\\main.c' },
      { name: 'speed', typeOffset: '0x10', address: 0x20000020, file: 'D:\\firmware\\src\\main.c' },
    ]);
    expect(dwarf.varToType.get('matrix')).toBe('0x20');
    const catalog = buildSymbolCatalog([{ name: 'matrix', address: 0x20000000, size: 24, type: 'B' }], dwarf);
    expect(symbolByteSize(catalog, '0x20')).toBe(24);
    expect(symbolTypeName(catalog, '0x20')).toBe('float[2][3]');
    const rows = symbolChildren(catalog, catalog.roots[0]);
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({ expression: 'matrix[1]', address: 0x2000000C, size: 12 });
    expect(symbolChildren(catalog, rows[1])[2]).toMatchObject({ expression: 'matrix[1][2]', address: 0x20000014, size: 4 });
  });
  it('marks duplicate static names unavailable rather than silently selecting a different address', () => {
    const catalog = buildSymbolCatalog([
      { name: 'state', address: 0x20000000, size: 4, type: 'b' },
      { name: 'state', address: 0x20000004, size: 4, type: 'b' },
    ], { varToType: new Map(), typeDefs: new Map() });
    expect(catalog.roots).toHaveLength(2);
    expect(catalog.roots.every(node => node.unavailable)).toBe(true);
  });
});
