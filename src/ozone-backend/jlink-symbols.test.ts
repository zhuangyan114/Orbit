import { describe, expect, it } from 'vitest';
import { parseDecodedLineMappings, resolveMappedStatementAddress } from './jlink-symbols';

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
