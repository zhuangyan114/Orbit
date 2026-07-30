import { describe, expect, it } from 'vitest';
import { RttChannelRegistry, RttChannelDescriptor } from './rtt-channel-registry';

const channel = (overrides: Partial<RttChannelDescriptor> = {}): RttChannelDescriptor => ({
  index: 1,
  name: 'trace',
  purpose: 'target trace stream',
  consumers: ['rtt'],
  buffer: { targetSizeBytes: 4096, hostQueueCapacityBytes: 8192 },
  ...overrides,
});

describe('RttChannelRegistry', () => {
  it('records channel identity, consumers and both target/host buffer capacities', () => {
    const registry = new RttChannelRegistry();
    expect(registry.register(channel())).toMatchObject({ ok: true, data: { index: 1, name: 'trace' } });
    expect(registry.getByName('trace')?.buffer).toEqual({
      targetSizeBytes: 4096,
      hostQueueCapacityBytes: 8192,
    });
    expect(registry.list()).toHaveLength(1);
  });

  it('rejects duplicate index/name and keeps explicit conflict records', () => {
    const registry = new RttChannelRegistry();
    registry.register(channel());

    const duplicateIndex = registry.register(channel({ name: 'other' }));
    expect(duplicateIndex.ok).toBe(false);
    expect(registry.conflicts(1)).toMatchObject([{ kind: 'duplicate-index', channelIndex: 1 }]);

    const duplicateName = registry.register(channel({ index: 2 }));
    expect(duplicateName.ok).toBe(false);
    expect(registry.conflicts(2)).toMatchObject([{ kind: 'duplicate-name', relatedChannelIndex: 1 }]);
    expect(registry.list()).toHaveLength(1);
  });

  it('records a channel disappearance and removes it from active registrations', () => {
    const registry = new RttChannelRegistry();
    registry.register(channel());

    expect(registry.unregister(1, 'target channel disappeared')?.name).toBe('trace');
    expect(registry.get(1)).toBeUndefined();
    expect(registry.conflicts(1)).toMatchObject([{ kind: 'channel-gone', message: 'target channel disappeared' }]);
  });
});
