import * as fs from 'fs';
import { describe, expect, it } from 'vitest';
import {
  activeDwarfVariables, findDwarfCallFrameRow, findDwarfSubprogram,
  parseDwarfTypeInfo, preloadLineMappings,
} from './jlink-symbols';

const targetElf = process.env.ORBIT_DOWN_CMAKE_ELF || '';

describe.runIf(!!targetElf && fs.existsSync(targetElf))('Down-cmake DWARF integration', () => {
  it('maps tasks.c:3650 to prvCheckTasksWaitingTermination and only exposes pxTCB', async () => {
    const [dwarf, lines] = await Promise.all([
      parseDwarfTypeInfo(targetElf),
      preloadLineMappings(targetElf),
    ]);
    const tasksEntries = Array.from(lines.entries())
      .filter(([file]) => /tasks\.c$/i.test(file))
      .flatMap(([, entries]) => entries)
      .filter(entry => entry.line === 3650 && entry.isStatement);
    expect(tasksEntries.length).toBeGreaterThan(0);
    const pc = tasksEntries[0].address;
    const subprogram = findDwarfSubprogram(dwarf, pc);
    expect(subprogram?.name).toBe('prvCheckTasksWaitingTermination');
    expect(subprogram && activeDwarfVariables(subprogram, pc).map(variable => variable.name)).toEqual(['pxTCB']);
    expect(findDwarfCallFrameRow(dwarf.callFrames, pc)).toMatchObject({ cfaRegister: 7, cfaOffset: 16 });
  });
});
