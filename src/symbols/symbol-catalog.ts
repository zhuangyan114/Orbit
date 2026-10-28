/** Serializable ELF metadata. Browsing this tree never reads target memory. */
export interface SymbolType {
  name: string;
  kind: string;
  byteSize: number;
  typeOffset?: string;
  arrayCount?: number;
  encoding?: string;
  fields?: { name: string; typeOffset: string; byteOffset: number; bitSize?: number }[];
}
export interface SymbolNode {
  id: string;
  expression: string;
  file: string;
  typeOffset: string;
  address?: number;
  size: number;
  pointerDepth: number;
  unavailable?: string;
  unsupportedTimeline?: string;
}
export interface SymbolCatalog { roots: SymbolNode[]; types: Record<string, SymbolType>; source?: 'recording'; elfPath?: string; }

export function symbolType(catalog: SymbolCatalog, offset: string): SymbolType | undefined {
  const seen = new Set<string>();
  while (offset && !seen.has(offset)) {
    seen.add(offset);
    const type = catalog.types[offset];
    if (!type || !['typedef', 'const', 'volatile', 'restrict'].includes(type.kind)) return type;
    offset = type.typeOffset || '';
  }
}

export function symbolTypeName(catalog: SymbolCatalog, offset: string, seen = new Set<string>()): string {
  if (!offset || seen.has(offset)) return '?';
  seen.add(offset);
  const type = catalog.types[offset];
  if (!type) return '?';
  if (type.name) return type.name;
  const inner = symbolTypeName(catalog, type.typeOffset || '', seen);
  if (type.kind === 'pointer') return `${inner} *`;
  if (type.kind === 'array') {
    const dimension = `[${type.arrayCount ?? '?'}]`;
    const nested = inner.indexOf('[');
    return nested < 0 ? `${inner}${dimension}` : `${inner.slice(0, nested)}${dimension}${inner.slice(nested)}`;
  }
  if (['const', 'volatile', 'restrict'].includes(type.kind)) return `${type.kind} ${inner}`;
  return type.kind === 'typedef' ? inner : type.kind;
}

export function symbolByteSize(catalog: SymbolCatalog, offset: string, seen = new Set<string>()): number {
  if (!offset || seen.has(offset)) return 0;
  seen.add(offset);
  const type = symbolType(catalog, offset);
  if (!type) return 0;
  return type.kind === 'array'
    ? (type.arrayCount || 0) * symbolByteSize(catalog, type.typeOffset || '', seen)
    : type.byteSize;
}

export function symbolChildCount(catalog: SymbolCatalog, node: SymbolNode): number {
  let type = symbolType(catalog, node.typeOffset);
  if (type?.kind === 'pointer') {
    if (node.pointerDepth >= 3) return 0;
    type = symbolType(catalog, type.typeOffset || '');
    // A pointer to a scalar/another pointer exposes the first pointee as [0].
    if (type && !['struct', 'union'].includes(type.kind)) return 1;
  }
  return type?.kind === 'array' ? type.arrayCount || 0 : type?.fields?.length || 0;
}

export function symbolChildren(catalog: SymbolCatalog, node: SymbolNode, start = 0, limit = 100): SymbolNode[] {
  let type = symbolType(catalog, node.typeOffset);
  const pointer = type?.kind === 'pointer';
  if (pointer) type = symbolType(catalog, type?.typeOffset || '');
  const count = symbolChildCount(catalog, node);
  const result: SymbolNode[] = [];
  for (let index = start; index < Math.min(count, start + limit); index++) {
    const field = type?.fields?.[index];
    const indexed = !field;
    const typeOffset = field?.typeOffset || (pointer ? symbolType(catalog, node.typeOffset)?.typeOffset : type?.typeOffset) || '';
    const expression = indexed ? `${node.expression}[${index}]` : `${node.expression}${pointer ? '->' : '.'}${field.name}`;
    const size = symbolByteSize(catalog, typeOffset);
    const delta = field?.byteOffset ?? index * size;
    const address = !pointer && node.address !== undefined && size > 0
      && Number.isSafeInteger(delta) && node.address + delta + size <= 0x1_0000_0000
      ? node.address + delta : undefined;
    result.push({ ...node, id: `${node.id}/${index}`, expression, typeOffset, size, address,
      ...(field?.bitSize ? { unsupportedTimeline: '暂不支持位域采样' } : {}),
      pointerDepth: node.pointerDepth + (pointer ? 1 : 0) });
  }
  return result;
}

export function canSelectSymbol(catalog: SymbolCatalog, node: SymbolNode, mode: 'watch' | 'timeline'): boolean {
  if (node.unavailable) return false;
  if (mode === 'watch') return true;
  const type = symbolType(catalog, node.typeOffset);
  if (catalog.source === 'recording' && type?.kind === 'recorded') return true;
  if (node.unsupportedTimeline || !/^[A-Za-z_]\w*(?:(?:\.|->)[A-Za-z_]\w*|\[\d+\])*$/.test(node.expression)) return false;
  // Exclude addresses, functions and aggregates; only numeric scalar leaves are sampled.
  return !!type && ['base', 'enum'].includes(type.kind) && [1, 2, 4, 8].includes(type.byteSize)
    && !/complex|imaginary|void/i.test(type.name);
}

/** Searches member names without expanding large arrays or recursive pointer graphs. */
export function symbolMatches(catalog: SymbolCatalog, node: SymbolNode, query: string): boolean {
  const needle = query.trim().toLowerCase().replace(/->/g, '.');
  if (!needle || `${node.expression} ${node.file} ${symbolTypeName(catalog, node.typeOffset)}`.toLowerCase().replace(/->/g, '.').includes(needle)) return true;
  const visit = (offset: string, path: string, seen: Set<string>, depth: number): boolean => {
    if (depth > 12 || (seen.has(offset) && depth >= Math.min(12, needle.split(/[.\[]/).length * 2))) return false;
    const type = symbolType(catalog, offset);
    if (!type) return false;
    const next = new Set(seen).add(offset);
    if (type.fields?.some(field => {
      const child = `${path}.${field.name}`;
      return child.toLowerCase().includes(needle) || visit(field.typeOffset, child, next, depth + 1);
    })) return true;
    if (type.typeOffset && ['array', 'pointer'].includes(type.kind)) {
      // Check an explicitly searched array index without materializing every element.
      const index = needle.match(/\[(\d+)\]/)?.[1] ?? '0';
      if (type.kind === 'array' && Number(index) >= (type.arrayCount || 0)) return false;
      const child = type.kind === 'array' ? `${path}[${index}]` : path;
      return (type.kind === 'array' && child.toLowerCase().includes(needle)) || visit(type.typeOffset, child, next, depth + 1);
    }
    return false;
  };
  return visit(node.typeOffset, node.expression.replace(/->/g, '.'), new Set(), 0);
}
