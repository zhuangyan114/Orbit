import type { FreeRtosLayout, Member } from './freertos-layout';
import { Field, known, unknown } from './model';
import { AddressRange, scalar, SnapshotMemory } from './snapshot-reader';

export const signedScalar = (bytes: Uint8Array, field: Member): number => {
  const raw = scalar(bytes, field);
  const bits = BigInt(field.size * 8);
  const signBit = 1n << (bits - 1n);
  return Number(raw >= signBit ? raw - (1n << bits) : raw);
};

export const isInRam = (address: number, size: number, ram: AddressRange[]): boolean =>
  Number.isSafeInteger(address) && Number.isSafeInteger(size) && address > 0 && size > 0 && address + size <= 0x1_0000_0000
  && ram.some(r => r.start <= address && address + size <= r.start + r.size);

export const ramSpanAt = (address: number, maxBytes: number, ram: AddressRange[]): number => {
  for (const r of ram) {
    if (r.start <= address && address < r.start + r.size) {
      return Math.min(maxBytes, r.start + r.size - address);
    }
  }
  return 0;
};

export function decodeCString(bytes: Uint8Array, source: string, maxBytes: number): Field<string> {
  const zero = bytes.indexOf(0);
  if (zero < 0) {
    return bytes.length < maxBytes
      ? unknown('String truncated before NUL terminator', source, 'text')
      : unknown(`String exceeds ${maxBytes} bytes without NUL terminator`, source, 'text');
  }
  return known(Buffer.from(bytes.subarray(0, zero)).toString('utf8'), source, 'text');
}

export async function resolveCString(
  address: number,
  source: string,
  memory: SnapshotMemory,
  readRodata?: (address: number, maxBytes: number) => Uint8Array | undefined,
  maxBytes = 64,
): Promise<Field<string>> {
  if (!address) return unknown('NULL string pointer', source, 'text');
  const roBytes = readRodata?.(address, maxBytes);
  if (roBytes) return decodeCString(roBytes, `${source} (ELF .rodata)`, maxBytes);
  const span = ramSpanAt(address, maxBytes, memory.request.ram);
  if (span <= 0) return unknown(`String pointer 0x${address.toString(16)} outside RAM and ELF RO segments`, source, 'text');
  try {
    const [ramBytes] = await memory.many([{ start: address, size: span }]);
    return decodeCString(ramBytes, `${source} (RAM)`, maxBytes);
  } catch (err) {
    return unknown(err instanceof Error ? err.message : String(err), source, 'text');
  }
}

export function hasValidListHeader(
  listBytes: Uint8Array,
  listAddress: number,
  layout: FreeRtosLayout,
  ram: AddressRange[],
  maxNodes: number,
): boolean {
  const count = Number(scalar(listBytes, layout.list.count));
  if (count > maxNodes) return false;
  const sentinel = listAddress + layout.list.end.offset;
  const next = Number(scalar(listBytes, layout.list.endNext));
  const prev = Number(scalar(listBytes, layout.list.endPrevious));
  if (count === 0) return next === sentinel && prev === sentinel;
  return isInRam(next, layout.item.size, ram) && isInRam(prev, layout.item.size, ram);
}
