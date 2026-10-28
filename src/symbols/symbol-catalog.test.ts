import { describe, expect, it } from 'vitest';
import { canSelectSymbol, symbolByteSize, symbolChildCount, symbolChildren, symbolMatches, symbolTypeName,
  type SymbolCatalog } from './symbol-catalog';
import { buildSymbolCatalog } from '../ozone-backend/jlink-symbols';
import { OzoneBackend } from '../ozone-backend/commander';

const catalog: SymbolCatalog = {
  roots: [{ id: 'motor', expression: 'motor', typeOffset: 'motor', file: 'D:\\firmware\\motor.c', address: 0x20000000, size: 20, pointerDepth: 0 }],
  types: {
    motor: { kind: 'struct', name: 'Motor', byteSize: 20, fields: [
      { name: 'speed', typeOffset: 'alias', byteOffset: 4 },
      { name: 'samples', typeOffset: 'array', byteOffset: 8 },
      { name: 'next', typeOffset: 'pointer', byteOffset: 16 },
      { name: 'flags', typeOffset: 'int', byteOffset: 0, bitSize: 3 },
    ] },
    alias: { kind: 'typedef', name: 'Speed', byteSize: 0, typeOffset: 'const' },
    const: { kind: 'const', name: '', byteSize: 0, typeOffset: 'float' },
    float: { kind: 'base', name: 'float', byteSize: 4 },
    int: { kind: 'base', name: 'int8_t', byteSize: 1 },
    array: { kind: 'array', name: '', byteSize: 0, typeOffset: 'int', arrayCount: 2000 },
    pointer: { kind: 'pointer', name: '', byteSize: 4, typeOffset: 'motor' },
    scalarPointer: { kind: 'pointer', name: '', byteSize: 4, typeOffset: 'float' },
    enum: { kind: 'enum', name: 'Mode', byteSize: 4 },
    func: { kind: 'subroutine', name: '', byteSize: 4 },
  },
};

describe('symbol browser tree', () => {
  it('allows aggregates in Watch and only numeric scalar leaves in Timeline', () => {
    const root = catalog.roots[0];
    const [speed, samples, pointer, bitfield] = symbolChildren(catalog, root);
    expect(canSelectSymbol(catalog, root, 'watch')).toBe(true);
    expect(canSelectSymbol(catalog, root, 'timeline')).toBe(false);
    expect(canSelectSymbol(catalog, speed, 'timeline')).toBe(true);
    expect(canSelectSymbol(catalog, samples, 'timeline')).toBe(false);
    expect(canSelectSymbol(catalog, pointer, 'timeline')).toBe(false);
    expect(canSelectSymbol(catalog, bitfield, 'timeline')).toBe(false);
    expect(canSelectSymbol(catalog, symbolChildren(catalog, samples)[0], 'timeline')).toBe(true);
    for (const typeOffset of ['enum', 'float', 'int']) expect(canSelectSymbol(catalog, { ...root, typeOffset }, 'timeline')).toBe(true);
    for (const typeOffset of ['func', 'missing']) expect(canSelectSymbol(catalog, { ...root, typeOffset }, 'timeline')).toBe(false);
  });
  it('uses byte strides and paginates arrays in numeric index order', () => {
    const array = symbolChildren(catalog, catalog.roots[0])[1];
    expect(symbolByteSize(catalog, 'array')).toBe(2000);
    expect(symbolChildCount(catalog, array)).toBe(2000);
    const children = symbolChildren(catalog, array, 1998, 100);
    expect(children.map(node => node.expression)).toEqual(['motor.samples[1998]', 'motor.samples[1999]']);
    expect(children[0].address).toBe(0x20000008 + 1998);
  });
  it('generates valid pointer member expressions without inventing runtime addresses', () => {
    const pointer = symbolChildren(catalog, catalog.roots[0])[2];
    const speed = symbolChildren(catalog, pointer)[0];
    expect(speed).toMatchObject({ expression: 'motor.next->speed', pointerDepth: 1, size: 4 });
    expect(speed.address).toBeUndefined();
    expect(canSelectSymbol(catalog, speed, 'timeline')).toBe(true);
    expect(symbolChildCount(catalog, { ...pointer, pointerDepth: 3 })).toBe(0);
    const scalar = symbolChildren(catalog, { ...pointer, typeOffset: 'scalarPointer' })[0];
    expect(scalar.expression).toBe('motor.next[0]');
    expect(canSelectSymbol(catalog, scalar, 'timeline')).toBe(true);
  });
  it('searches fields, typedefs, files and large array indices without unfolding every element', () => {
    for (const query of ['speed', 'Speed', 'motor.c', 'motor.samples[1999]', 'motor.next->speed']) {
      expect(symbolMatches(catalog, catalog.roots[0], query), query).toBe(true);
    }
    expect(symbolMatches(catalog, catalog.roots[0], 'motor.samples[2000]')).toBe(false);
    expect(symbolMatches(catalog, catalog.roots[0], 'not_present')).toBe(false);
    expect(symbolTypeName(catalog, 'array')).toBe('int8_t[2000]');
    expect(symbolTypeName(catalog, 'pointer')).toBe('Motor *');
  });
  it('rejects ambiguous roots and descendants and unsafe addresses', () => {
    const ambiguous = { ...catalog.roots[0], unavailable: 'duplicate' };
    expect(canSelectSymbol(catalog, ambiguous, 'watch')).toBe(false);
    expect(canSelectSymbol(catalog, symbolChildren(catalog, ambiguous)[0], 'timeline')).toBe(false);
    expect(symbolChildren(catalog, { ...catalog.roots[0], address: 0xFFFFFFFE })[0].address).toBeUndefined();
  });
  it('builds a serializable variable-only catalog grouped by compilation source', () => {
    const built = buildSymbolCatalog([
      { name: 'motor', address: 0x20000000, size: 20, type: 'B' },
      { name: 'main', address: 0x08000000, size: 100, type: 'T' },
    ], { varToType: new Map([['motor', 'motor']]), typeDefs: new Map(Object.entries(catalog.types)) as any,
      globals: [{ name: 'motor', typeOffset: 'motor', address: 0x20000000, file: 'motor.c' }] });
    expect(built.roots).toHaveLength(1);
    expect(built.roots[0]).toMatchObject({ expression: 'motor', file: 'motor.c' });
    expect(JSON.parse(JSON.stringify(built))).toEqual(built);
  });
  it('serves ELF metadata without connecting or reading the target', async () => {
    const backend = new OzoneBackend();
    expect((await backend.execute({ cmd: 'getSymbolCatalog' })).ok).toBe(false);
    Object.assign(backend, { elfPath: 'fixture.elf', symbols: [{ name: 'motor', address: 0x20000000, size: 20, type: 'B' }],
      dwarfInfo: { varToType: new Map([['motor', 'motor']]), typeDefs: new Map(Object.entries(catalog.types)) } });
    const result = await backend.execute({ cmd: 'getSymbolCatalog' });
    expect(result.ok && (result.data as SymbolCatalog).roots[0].expression).toBe('motor');
    expect(backend.hasTargetConnection).toBe(false);
  });
});
