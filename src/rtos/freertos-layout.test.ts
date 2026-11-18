import { describe, expect, it } from 'vitest';
import { existsSync } from 'fs';
import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import { buildSymbolCatalog, parseDwarfTypeInfo, readElfSymbols } from '../ozone-backend/jlink-symbols';
import { compileFreeRtosLayout, FreeRtosLayoutCache } from './freertos-layout';
import { testCatalog } from './test-fixture';

describe('FreeRTOS layout compiler', () => {
  it('follows the root DIE through qualifiers, ignoring unrelated same-named types', () => {
    const plan = compileFreeRtosLayout(testCatalog(), 'a');
    expect(plan.tcb.fields.xStateListItem.offset).toBe(12);
    expect(plan.list.endNext.offset).toBe(24);
    expect(plan.tcb.stackWordBytes).toBe(4);
    expect(plan.lists).toHaveLength(7);
  });
  it('reports absent kernels, missing DWARF and ambiguous global roots', () => {
    const catalog = testCatalog();
    catalog.roots = [];
    expect(() => compileFreeRtosLayout(catalog, 'a')).toThrow('Missing kernel root');
    const missing = testCatalog(); missing.roots[0].typeOffset = '';
    expect(() => compileFreeRtosLayout(missing, 'a')).toThrow('No DWARF');
    const ambiguous = testCatalog(); ambiguous.roots.push({ ...ambiguous.roots[0], address: 0x2000 });
    expect(() => compileFreeRtosLayout(ambiguous, 'a')).toThrow('Multiple globals');
  });
  it('rejects truncated/bitfield members and unknown pointer ABIs', () => {
    for (const corrupt of [(c: ReturnType<typeof testCatalog>) => { c.types.tcb.byteSize = 20; },
      (c: ReturnType<typeof testCatalog>) => { c.types.taskPtr.byteSize = 8; },
      (c: ReturnType<typeof testCatalog>) => { c.types.list.fields![0].bitSize = 2; }]) {
      const c = testCatalog(); corrupt(c); expect(() => compileFreeRtosLayout(c, 'a')).toThrow();
    }
  });
  it('degrades optional fields and keys layouts by ELF contents', () => {
    const c = testCatalog(); c.types.tcb.fields = c.types.tcb.fields!.filter(f => f.name !== 'ulRunTimeCounter');
    const cache = new FreeRtosLayoutCache(), a = cache.get(c, 'a');
    expect(a.tcb.fields.ulRunTimeCounter).toBeUndefined();
    expect(cache.get(c, 'a')).toBe(a);
    expect(cache.get(c, 'b').layoutId).not.toBe(a.layoutId);
  });
});

const fixtureRoot = process.env.ORBIT_RTOS_FIXTURES || 'out/rtos-stage0/fixtures/arm';
const variants = ['native-debug', 'cmsis-v1', 'cmsis-v2', 'native-optimized', 'native-no-stats', 'native-no-stack-bound', 'native-tickless', 'native-no-dwarf'];
describe('fixed stage-0 ELF layouts (requires offline fixture build)', () => {
  for (const variant of variants) {
    const file = `${fixtureRoot}/${variant}.elf`;
    it.runIf(existsSync(file))(`compiles ${variant}`, async () => {
      const [symbols, dwarf] = await Promise.all([readElfSymbols(file), parseDwarfTypeInfo(file)]);
      const compile = () => compileFreeRtosLayout(buildSymbolCatalog(symbols, dwarf), createHash('sha256').update(readFileSync(file)).digest('hex'));
      if (variant === 'native-no-dwarf') { expect(compile).toThrow('No DWARF'); return; }
      const layout = compile();
      expect(layout.lists.filter(list => list.state === 'ready')).toHaveLength(variant === 'cmsis-v2' ? 56 : 8);
      expect(!!layout.tcb.fields.ulRunTimeCounter).toBe(variant !== 'native-no-stats');
      expect(!!layout.tcb.fields.pxEndOfStack).toBe(variant !== 'native-no-stack-bound');
      expect(layout.tcb.size).toBe(variant === 'native-no-stats' || variant === 'native-no-stack-bound' ? 96 : 100);
    }, 30000);
  }
});
