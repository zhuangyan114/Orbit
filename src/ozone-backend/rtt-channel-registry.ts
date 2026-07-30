/**
 * Session-local RTT channel inventory.
 *
 * The registry is deliberately independent from the physical owner. Native
 * and Legacy owners publish the same channel description, while stream
 * consumers use the registry to reject an unknown or conflicting channel
 * before touching the target.
 */

export type RttStreamConsumer = 'watch' | 'timeline' | 'rtt';

export interface RttChannelBuffer {
  /** Capacity reported by the target RTT channel. */
  readonly targetSizeBytes: number;
  /** Host-side bounded queue capacity for this channel. */
  readonly hostQueueCapacityBytes: number;
}

export type RttChannelConflictKind =
  | 'duplicate-index'
  | 'duplicate-name'
  | 'channel-gone'
  | 'buffer-mismatch'
  | 'manual';

export interface RttChannelConflict {
  readonly kind: RttChannelConflictKind;
  readonly channelIndex: number;
  readonly message: string;
  readonly relatedChannelIndex?: number;
  readonly detectedAt: number;
}

export interface RttChannelDescriptor {
  readonly index: number;
  readonly name: string;
  readonly purpose: string;
  readonly consumers: readonly RttStreamConsumer[];
  readonly buffer: RttChannelBuffer;
}

export type RttChannelRegistryResult<T> =
  | { readonly ok: true; readonly data: T; readonly conflicts: readonly RttChannelConflict[] }
  | { readonly ok: false; readonly message: string; readonly conflicts: readonly RttChannelConflict[] };

/** Maintains one unambiguous description for each RTT channel index. */
export class RttChannelRegistry {
  private readonly channelsByIndex = new Map<number, RttChannelDescriptor>();
  private readonly indexesByName = new Map<string, number>();
  private readonly allConflicts: RttChannelConflict[] = [];

  register(descriptor: RttChannelDescriptor): RttChannelRegistryResult<RttChannelDescriptor> {
    const validation = validateDescriptor(descriptor);
    if (validation) {
      const conflict = this.recordConflict({
        kind: 'manual',
        channelIndex: descriptor.index,
        message: validation,
      });
      return { ok: false, message: validation, conflicts: [conflict] };
    }

    const conflicts: RttChannelConflict[] = [];
    const existingByIndex = this.channelsByIndex.get(descriptor.index);
    if (existingByIndex) {
      conflicts.push(this.recordConflict({
        kind: 'duplicate-index',
        channelIndex: descriptor.index,
        relatedChannelIndex: existingByIndex.index,
        message: `RTT channel index ${descriptor.index} is already registered as ${existingByIndex.name}`,
      }));
    }

    const existingIndexByName = this.indexesByName.get(descriptor.name);
    if (existingIndexByName !== undefined && existingIndexByName !== descriptor.index) {
      conflicts.push(this.recordConflict({
        kind: 'duplicate-name',
        channelIndex: descriptor.index,
        relatedChannelIndex: existingIndexByName,
        message: `RTT channel name ${descriptor.name} is already registered at index ${existingIndexByName}`,
      }));
    }

    if (conflicts.length > 0) {
      return { ok: false, message: conflicts[0].message, conflicts };
    }

    this.channelsByIndex.set(descriptor.index, descriptor);
    this.indexesByName.set(descriptor.name, descriptor.index);
    return { ok: true, data: descriptor, conflicts: [] };
  }

  unregister(index: number, reason = 'RTT channel disappeared'): RttChannelDescriptor | undefined {
    const descriptor = this.channelsByIndex.get(index);
    if (!descriptor) return undefined;
    this.channelsByIndex.delete(index);
    this.indexesByName.delete(descriptor.name);
    this.recordConflict({ kind: 'channel-gone', channelIndex: index, message: reason });
    return descriptor;
  }

  get(index: number): RttChannelDescriptor | undefined {
    return this.channelsByIndex.get(index);
  }

  getByName(name: string): RttChannelDescriptor | undefined {
    const index = this.indexesByName.get(name);
    return index === undefined ? undefined : this.channelsByIndex.get(index);
  }

  list(): readonly RttChannelDescriptor[] {
    return [...this.channelsByIndex.values()].sort((left, right) => left.index - right.index);
  }

  conflicts(index?: number): readonly RttChannelConflict[] {
    return index === undefined
      ? [...this.allConflicts]
      : this.allConflicts.filter(conflict => conflict.channelIndex === index);
  }

  recordConflict(conflict: Omit<RttChannelConflict, 'detectedAt'>): RttChannelConflict {
    const recorded = { ...conflict, detectedAt: Date.now() };
    this.allConflicts.push(recorded);
    return recorded;
  }

  clear() {
    this.channelsByIndex.clear();
    this.indexesByName.clear();
    this.allConflicts.length = 0;
  }
}

function validateDescriptor(descriptor: RttChannelDescriptor): string | undefined {
  if (!Number.isInteger(descriptor.index) || descriptor.index < 0) {
    return `RTT channel index must be a non-negative integer: ${descriptor.index}`;
  }
  if (!descriptor.name.trim()) return 'RTT channel name must not be empty';
  if (!descriptor.purpose.trim()) return `RTT channel ${descriptor.index} purpose must not be empty`;
  if (descriptor.consumers.length === 0) return `RTT channel ${descriptor.index} must have at least one consumer`;
  if (new Set(descriptor.consumers).size !== descriptor.consumers.length) {
    return `RTT channel ${descriptor.index} contains duplicate consumers`;
  }
  if (!Number.isInteger(descriptor.buffer.targetSizeBytes) || descriptor.buffer.targetSizeBytes <= 0) {
    return `RTT channel ${descriptor.index} target buffer size must be positive`;
  }
  if (!Number.isInteger(descriptor.buffer.hostQueueCapacityBytes) || descriptor.buffer.hostQueueCapacityBytes <= 0) {
    return `RTT channel ${descriptor.index} host queue capacity must be positive`;
  }
  return undefined;
}
