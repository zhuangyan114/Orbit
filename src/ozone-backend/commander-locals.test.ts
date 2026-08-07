import { describe, expect, it } from 'vitest';
import { OzoneBackend } from './commander';
import { parseDwarfLocalMetadata } from './jlink-symbols';

describe('DWARF stopped-state locals', () => {
  it('parses frame-relative locals and the active CFA rule independently', () => {
    const info = `
 <1><100>: Abbrev Number: 1 (DW_TAG_subprogram)
    <101>   DW_AT_name        : StartTask02
    <102>   DW_AT_low_pc      : 0x08003f4c
    <103>   DW_AT_high_pc     : 0xd0
    <104>   DW_AT_frame_base  : 1 byte block: 9c (DW_OP_call_frame_cfa)
 <2><110>: Abbrev Number: 2 (DW_TAG_variable)
    <111>   DW_AT_name        : local_data
    <112>   DW_AT_type        : <0x200>
    <113>   DW_AT_location    : 2 byte block: 91 70 (DW_OP_fbreg: -16)
`;
    const frames = `
000043f4 0000001c 000042dc FDE cie=000042dc pc=08003f4c..0800401c
   LOC   CFA      r7    ra
08003f4c r13+0    u     u
08003f50 r13+40   c-8   c-4
08003f52 r7+40    c-8   c-4

00004414 0000000c ffffffff CIE "" cf=2 df=-4 ra=14
   LOC   CFA
00000000 r13+0
`;

    expect(parseDwarfLocalMetadata(info, frames)).toEqual({
      localVariables: [{
        name: 'local_data',
        typeOffset: '0x200',
        lowPc: 0x08003f4c,
        highPc: 0x0800401c,
        fbregOffset: -16,
      }],
      cfaRows: [
        { lowPc: 0x08003f4c, highPc: 0x08003f50, registerIndex: 13, offset: 0 },
        { lowPc: 0x08003f50, highPc: 0x08003f52, registerIndex: 13, offset: 40 },
        { lowPc: 0x08003f52, highPc: 0x0800401c, registerIndex: 7, offset: 40 },
      ],
    });
  });

  it('reads only current-scope locals through the DWARF CFA and fbreg contract', async () => {
    const backend = new OzoneBackend();
    const internal = backend as any;
    internal.dwarfInfo = {
      varToType: new Map(),
      typeDefs: new Map([
        ['uint32', { name: 'uint32_t', byteSize: 4, kind: 'base', encoding: 'unsigned' }],
      ]),
      localVariables: [
        { name: 'local_data', typeOffset: 'uint32', lowPc: 0x08003f4c, highPc: 0x0800401c, fbregOffset: -16 },
        { name: 'other_scope', typeOffset: 'uint32', lowPc: 0x08005000, highPc: 0x08005100, fbregOffset: -20 },
      ],
      cfaRows: [
        { lowPc: 0x08003f52, highPc: 0x0800401c, registerIndex: 7, offset: 40 },
      ],
    };
    internal.targetIsHalted = async () => true;
    internal.targetReadRegister = async (index: number) => {
      if (index === 15) return 0x08003f7e;
      if (index === 7) return 0x20001000;
      return null;
    };
    const reads: Array<{ address: number; size: number }> = [];
    internal.targetReadMemory = async (address: number, size: number) => {
      reads.push({ address, size });
      return address === 0x20001018
        ? Uint8Array.from([0x44, 0x44, 0x44, 0x44])
        : null;
    };

    const result = await backend.execute({ cmd: 'getLocals' });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    expect(result.data).toEqual([{
      name: 'local_data',
      type: 'uint32_t',
      value: '0x44444444 (1145324612)',
      address: 0x20001018,
    }]);
    expect(reads).toEqual([{ address: 0x20001018, size: 4 }]);
  });
});
