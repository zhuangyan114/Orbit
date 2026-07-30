import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import {
  activeDwarfVariables, dwarfLocationExpressionAt, findDwarfCallFrameRow,
  OBJDUMP_EXE, parseDecodedLineMappings, parseDwarfCallFrames,
  parseDwarfLocationLists, parseDwarfRangeLists, parseDwarfTypeInfo,
  readElfSymbols, resolveMappedStatementAddress,
} from './jlink-symbols';

describe('parseDecodedLineMappings', () => {
  it('marks only DWARF statement rows as valid breakpoint locations', () => {
    const map = parseDecodedLineMappings(`
File name                            Line number    Starting address    View    Stmt
main.c                                         10          0x08000100               x
main.c                                         11          0x08000104
main.c                                         12          0x08000108               x
main.c                                          -          0x0800010c
`);

    expect(map.get('main.c')).toEqual([
      { line: 10, address: 0x08000100, isStatement: true },
      { line: 11, address: 0x08000104, isStatement: false },
      { line: 12, address: 0x08000108, isStatement: true },
    ]);
  });

  it('keeps legacy decodedline output usable when no Stmt column is present', () => {
    const map = parseDecodedLineMappings(`
main.c 10 0x08000100
main.c 12 0x08000108
`);

    expect(map.get('main.c')).toEqual([
      { line: 10, address: 0x08000100, isStatement: true },
      { line: 12, address: 0x08000108, isStatement: true },
    ]);
  });

  it('resolves only exact statement lines without snapping to nearby code', () => {
    const map = parseDecodedLineMappings(`
File name                            Line number    Starting address    View    Stmt
main.c                                         10          0x08000100               x
main.c                                         11          0x08000104
main.c                                         12          0x08000108               x
`);

    expect(resolveMappedStatementAddress(map, 'C:\\project\\main.c', 10)).toBe(0x08000100);
    expect(resolveMappedStatementAddress(map, 'C:\\project\\main.c', 11)).toBeNull();
    expect(resolveMappedStatementAddress(map, 'C:\\project\\main.c', 13)).toBeNull();
  });
});

describe('DWARF debug information', () => {
  it('binds locals to their subprogram and active lexical block', async () => {
    const infoText = `
 <0><0>: Abbrev Number: 1 (DW_TAG_compile_unit)
 <1><10>: Abbrev Number: 2 (DW_TAG_base_type)
    <11>   DW_AT_name        : int
    <12>   DW_AT_byte_size   : 4
    <13>   DW_AT_encoding    : 5 (signed)
 <1><20>: Abbrev Number: 3 (DW_TAG_variable)
    <21>   DW_AT_name        : global_only
    <22>   DW_AT_type        : <0x10>
    <23>   DW_AT_location    : 5 byte block: 3 00 20 00 20 (DW_OP_addr: 20002000)
 <1><40>: Abbrev Number: 4 (DW_TAG_subprogram)
    <41>   DW_AT_name        : C
    <42>   DW_AT_low_pc      : 0x08000100
    <43>   DW_AT_high_pc     : 0x40
    <44>   DW_AT_frame_base  : 1 byte block: 9c (DW_OP_call_frame_cfa)
 <2><50>: Abbrev Number: 5 (DW_TAG_formal_parameter)
    <51>   DW_AT_name        : parameter
    <52>   DW_AT_type        : <0x10>
    <53>   DW_AT_location    : 2 byte block: 91 70 (DW_OP_fbreg: -16)
 <2><60>: Abbrev Number: 3 (DW_TAG_variable)
    <61>   DW_AT_name        : c_local
    <62>   DW_AT_type        : <0x10>
    <63>   DW_AT_location    : 2 byte block: 91 74 (DW_OP_fbreg: -12)
 <2><70>: Abbrev Number: 6 (DW_TAG_lexical_block)
    <71>   DW_AT_low_pc      : 0x08000110
    <72>   DW_AT_high_pc     : 0x10
 <3><80>: Abbrev Number: 3 (DW_TAG_variable)
    <81>   DW_AT_name        : inner
    <82>   DW_AT_type        : <0x10>
    <83>   DW_AT_location    : 2 byte block: 91 6c (DW_OP_fbreg: -20)
`;
    const info = await parseDwarfTypeInfo('fixture.elf', async mode => mode === 'info' ? infoText : '');
    expect(info.subprograms).toHaveLength(1);
    expect(activeDwarfVariables(info.subprograms[0], 0x08000108).map(variable => variable.name))
      .toEqual(['parameter', 'c_local']);
    expect(activeDwarfVariables(info.subprograms[0], 0x08000118).map(variable => variable.name))
      .toEqual(['parameter', 'c_local', 'inner']);
    expect(activeDwarfVariables(info.subprograms[0], 0x08000118).some(variable => variable.name === 'global_only'))
      .toBe(false);
  });

  it('parses ranges, location lists and Cortex-M CFI rows', () => {
    const ranges = parseDwarfRangeLists(`
    00000020 08000100 08000110
    0000002c 08000120 08000130
    00000038 <End of list>
`);
    expect(ranges.get(0x20)).toEqual([
      { start: 0x08000100, end: 0x08000110 },
      { start: 0x08000120, end: 0x08000130 },
    ]);

    const locations = parseDwarfLocationLists(`
    00000010 08000100 08000110 (DW_OP_reg0 (r0))
    0000001c 08000110 08000120 (DW_OP_fbreg: -12)
    00000028 <End of list>
`);
    expect(dwarfLocationExpressionAt({ listOffset: 0x10 }, 0x08000114, locations)).toBe('DW_OP_fbreg: -12');

    const frames = parseDwarfCallFrames(`
00000010 00000020 00000000 FDE cie=00000000 pc=08000100..08000140
   LOC   CFA      r7    ra
08000100 r13+0    u     u
08000102 r13+8    c-8   c-4
08000104 r7+16    c-8   c-4
`);
    const row = findDwarfCallFrameRow(frames, 0x08000108);
    expect(row).toMatchObject({ cfaRegister: 7, cfaOffset: 16 });
    expect(row?.registerRules.get(14)).toEqual({ kind: 'cfaOffset', value: -4 });
  });

  const gcc = OBJDUMP_EXE.replace(/objdump(?:\.exe)?$/i, 'gcc.exe');
  it.runIf(fs.existsSync(gcc))('parses the fixed -Og A -> B -> C ELF fixture', async () => {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-dwarf-abc-'));
    try {
      const source = path.resolve('test/fixtures/dwarf-abc.c');
      const elf = path.join(temporary, 'dwarf-abc.elf');
      execFileSync(gcc, [
        '-mcpu=cortex-m4', '-mthumb', '-Og', '-g3', '-fno-inline',
        '-fno-optimize-sibling-calls', '-fno-omit-frame-pointer', '-fno-lto',
        '-nostdlib', '-Wl,-Ttext=0x08000000', '-Wl,-e,Reset_Handler', source, '-o', elf,
      ], { stdio: 'pipe' });
      const [dwarf, symbols] = await Promise.all([parseDwarfTypeInfo(elf), readElfSymbols(elf)]);
      for (const name of ['C', 'B', 'A']) {
        expect(dwarf.subprograms.some(subprogram => subprogram.name === name)).toBe(true);
        expect(symbols.some(symbol => symbol.name === name && (symbol.type === 'T' || symbol.type === 't'))).toBe(true);
      }
      const c = dwarf.subprograms.find(subprogram => subprogram.name === 'C')!;
      expect(activeDwarfVariables(c, c.ranges[0].start + 2).map(variable => variable.name))
        .toEqual(expect.arrayContaining(['c_local', 'c_array', 'c_struct']));
      expect(findDwarfCallFrameRow(dwarf.callFrames, c.ranges[0].start + 4)).toBeDefined();
    } finally {
      fs.rmSync(temporary, { recursive: true, force: true });
    }
  });
});
