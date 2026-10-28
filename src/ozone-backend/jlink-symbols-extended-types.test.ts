import { beforeEach, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({ info: '' }));

vi.mock('child_process', () => ({
  execFile: vi.fn((_file: string, args: string[], _options: unknown, callback: Function) => {
    callback(null, args.includes('--dwarf=info') ? fixture.info : '', '');
  }),
}));

import { parseDwarfTypeInfo } from './jlink-symbols';
import { OzoneBackend } from './commander';

describe('parseDwarfTypeInfo extended scalar metadata', () => {
  beforeEach(() => {
    fixture.info = `
 <0><0>: Abbrev Number: 1 (DW_TAG_compile_unit)
 <1><20>: Abbrev Number: 2 (DW_TAG_enumeration_type)
    <21>   DW_AT_name        : Dap06Mode
    <22>   DW_AT_byte_size   : 4
 <2><23>: Abbrev Number: 3 (DW_TAG_enumerator)
    <24>   DW_AT_name        : DAP06_IDLE
    <25>   DW_AT_const_value : -1
 <2><26>: Abbrev Number: 3 (DW_TAG_enumerator)
    <27>   DW_AT_name        : DAP06_RUN
    <28>   DW_AT_const_value : 2
 <1><30>: Abbrev Number: 4 (DW_TAG_subroutine_type)
    <31>   DW_AT_name        : uint32_t (uint32_t)
    <32>   DW_AT_byte_size   : 4
 <1><40>: Abbrev Number: 5 (DW_TAG_variable)
    <41>   DW_AT_name        : g_dap06_mode
    <42>   DW_AT_type        : <0x20>
`;
  });

  it('preserves enum names and signed values', async () => {
    const dwarf = await parseDwarfTypeInfo('fixture.elf');
    expect(dwarf.typeDefs.get('0x20')).toMatchObject({
      kind: 'enum',
      enumerators: [
        { name: 'DAP06_IDLE', value: '-1' },
        { name: 'DAP06_RUN', value: '2' },
      ],
    });
  });

  it('records subroutine types for function-pointer resolution', async () => {
    const dwarf = await parseDwarfTypeInfo('fixture.elf');
    expect(dwarf.typeDefs.get('0x30')).toMatchObject({
      kind: 'subroutine',
      name: 'uint32_t (uint32_t)',
      byteSize: 4,
    });
  });

  it('preserves GCC multiple subranges, row stride and bounds in real fast plans',async()=>{
    fixture.info+=`
 <1><80>: Abbrev Number: 1 (DW_TAG_base_type)
    <81> DW_AT_name : uint32_t
    <82> DW_AT_byte_size : 4
 <1><90>: Abbrev Number: 2 (DW_TAG_array_type)
    <91> DW_AT_type : <0x80>
 <2><95>: Abbrev Number: 3 (DW_TAG_subrange_type)
    <96> DW_AT_upper_bound : 9
 <2><a0>: Abbrev Number: 3 (DW_TAG_subrange_type)
    <a1> DW_AT_upper_bound : 15
 <1><b0>: Abbrev Number: 4 (DW_TAG_volatile_type)
    <b1> DW_AT_type : <0x90>
 <1><c0>: Abbrev Number: 5 (DW_TAG_variable)
    <c1> DW_AT_name : matrix
    <c2> DW_AT_type : <0xb0>
`;
    const dwarf=await parseDwarfTypeInfo('fixture.elf');
    const outer=dwarf.typeDefs.get('0x90')!;
    expect(outer).toMatchObject({kind:'array',arrayCount:10,byteSize:640});
    expect(dwarf.typeDefs.get(outer.typeOffset!)).toMatchObject({kind:'array',arrayCount:16,byteSize:64});
    const backend=new OzoneBackend(),internal=backend as any;
    internal.dwarfInfo=dwarf;internal.symbols=[{name:'matrix',address:0x20000100,size:640}];
    const result=await backend.execute({cmd:'prepareFastDataSampling',expressions:[
      'matrix[0][0]','matrix[1][0]','matrix[9][15]','matrix[10][0]','matrix[0][16]','matrix[1]','matrix[i][0]']});
    const rows=(result as any).data;
    expect(rows.slice(0,3).map((row:any)=>row.spec.address)).toEqual([0x20000100,0x20000140,0x2000037c]);
    expect(rows.slice(3).every((row:any)=>row.error && !row.spec)).toBe(true);
    expect(internal.getDwarfTypeName('0x90')).toBe('uint32_t[10][16]');
    await backend.dispose();
  });

  it('accepts constant count and one-element bounds while rejecting unknown dimensions',async()=>{
    fixture.info+=`
 <1><80>: Abbrev Number: 1 (DW_TAG_base_type)
    <81> DW_AT_name : uint32_t
    <82> DW_AT_byte_size : 4
 <1><90>: Abbrev Number: 2 (DW_TAG_array_type)
    <91> DW_AT_type : <0x80>
 <2><95>: Abbrev Number: 3 (DW_TAG_subrange_type)
    <96> DW_AT_count : 3
 <1><a0>: Abbrev Number: 2 (DW_TAG_array_type)
    <a1> DW_AT_type : <0x80>
 <2><a5>: Abbrev Number: 3 (DW_TAG_subrange_type)
    <a6> DW_AT_upper_bound : 0
 <1><b0>: Abbrev Number: 2 (DW_TAG_array_type)
    <b1> DW_AT_type : <0x80>
 <2><b5>: Abbrev Number: 3 (DW_TAG_subrange_type)
    <b6> DW_AT_upper_bound : (DW_OP_fbreg: -12)
`;
    const dwarf=await parseDwarfTypeInfo('fixture.elf');
    expect(dwarf.typeDefs.get('0x90')).toMatchObject({arrayCount:3,byteSize:12});
    expect(dwarf.typeDefs.get('0xa0')).toMatchObject({arrayCount:1,byteSize:4});
    expect(dwarf.typeDefs.get('0xb0')).toMatchObject({arrayCount:0,byteSize:0});
  });
});
