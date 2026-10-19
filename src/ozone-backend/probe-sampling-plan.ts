import type { ProbeSamplingItem } from './cmsis-dap-helper-channel';
import type { FastDataSampleSpec } from './types';

/** XR-DAP item offsets are signed 16-bit; fast-sampling offsets are never negative. */
const MAX_PROBE_OFFSET = 0x7FFF;

function fitsOffset(offset: number): boolean {
  return Number.isInteger(offset) && offset >= 0 && offset <= MAX_PROBE_OFFSET;
}

/**
 * Maps one fast-sampling spec onto an XR-DAP probe item, or null when the
 * probe encoding cannot express it. The probe reads `base`, then for each
 * deref offset reads the pointer at the current address plus that offset,
 * then reads the value at the last pointer plus `finalOffset`.
 */
export function probeSamplingItem(spec: FastDataSampleSpec): ProbeSamplingItem | null {
  const size = spec.size;
  if (size !== 1 && size !== 2 && size !== 4 && size !== 8) return null;
  if (spec.pointerChain?.length) {
    // chain[0] holds the pointer storage; chain[1..n-2] offset into each
    // intermediate pointee; the last entry offsets the scalar.
    const chain = spec.pointerChain;
    const derefs = [0, ...chain.slice(1, -1).map(step => step.offset)];
    const finalOffset = chain[chain.length - 1].offset;
    if (!derefs.every(fitsOffset) || !fitsOffset(finalOffset)) return null;
    return { size, base: chain[0].pointerAddress >>> 0, derefs, finalOffset };
  }
  if (spec.pointerAddress !== undefined) {
    const finalOffset = spec.pointeeOffset ?? 0;
    if (!fitsOffset(finalOffset)) return null;
    return { size, base: spec.pointerAddress >>> 0, derefs: [0], finalOffset };
  }
  return { size, base: spec.address >>> 0 };
}

/** Items for every spec, or null when any spec does not fit the probe encoding. */
export function probeSamplingItems(specs: FastDataSampleSpec[]): ProbeSamplingItem[] | null {
  const items: ProbeSamplingItem[] = [];
  for (const spec of specs) {
    const item = probeSamplingItem(spec);
    if (!item) return null;
    items.push(item);
  }
  return items;
}
