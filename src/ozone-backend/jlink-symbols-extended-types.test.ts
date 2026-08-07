import { beforeEach, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({ info: '' }));

vi.mock('child_process', () => ({
  execFile: vi.fn((_file: string, args: string[], _options: unknown, callback: Function) => {
    callback(null, args.includes('--dwarf=info') ? fixture.info : '', '');
  }),
}));

import { parseDwarfTypeInfo } from './jlink-symbols';

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
});
