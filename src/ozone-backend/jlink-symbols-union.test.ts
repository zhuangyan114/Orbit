import { beforeEach, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({ info: '' }));

vi.mock('child_process', () => ({
  execFile: vi.fn((_file: string, args: string[], _options: unknown, callback: Function) => {
    callback(null, args.includes('--dwarf=info') ? fixture.info : '', '');
  }),
}));

import { parseDwarfTypeInfo } from './jlink-symbols';

describe('parseDwarfTypeInfo unions', () => {
  beforeEach(() => {
    fixture.info = `
 <0><0>: Abbrev Number: 1 (DW_TAG_compile_unit)
 <1><10>: Abbrev Number: 2 (DW_TAG_union_type)
    <11>   DW_AT_name        : Dap06Union
    <12>   DW_AT_byte_size   : 4
 <2><20>: Abbrev Number: 3 (DW_TAG_member)
    <21>   DW_AT_name        : raw
    <22>   DW_AT_type        : <0x40>
 <2><30>: Abbrev Number: 3 (DW_TAG_member)
    <31>   DW_AT_name        : bytes
    <32>   DW_AT_type        : <0x50>
    <33>   DW_AT_data_member_location: 0
 <1><40>: Abbrev Number: 4 (DW_TAG_base_type)
    <41>   DW_AT_name        : uint32_t
    <42>   DW_AT_byte_size   : 4
    <43>   DW_AT_encoding    : unsigned
 <1><50>: Abbrev Number: 5 (DW_TAG_array_type)
    <51>   DW_AT_type        : <0x60>
 <2><55>: Abbrev Number: 6 (DW_TAG_subrange_type)
    <56>   DW_AT_upper_bound : 3
 <1><60>: Abbrev Number: 4 (DW_TAG_base_type)
    <61>   DW_AT_name        : uint8_t
    <62>   DW_AT_byte_size   : 1
    <63>   DW_AT_encoding    : unsigned char
 <1><70>: Abbrev Number: 7 (DW_TAG_variable)
    <71>   DW_AT_name        : g_dap06_union
    <72>   DW_AT_type        : <0x10>
`;
  });

  it('parses a union and defaults omitted member locations to offset zero', async () => {
    const dwarf = await parseDwarfTypeInfo('fixture.elf');

    expect(dwarf.varToType.get('g_dap06_union')).toBe('0x10');
    expect(dwarf.typeDefs.get('0x10')).toEqual({
      name: 'Dap06Union',
      byteSize: 4,
      kind: 'union',
      fields: [
        { name: 'raw', typeOffset: '0x40', byteOffset: 0 },
        { name: 'bytes', typeOffset: '0x50', byteOffset: 0 },
      ],
    });
  });
});
