import { describe, expect, it } from 'vitest';
import { SystemViewEventDecoder } from './systemview-event-decoder';
import { SystemViewMetadataStore, parseSystemViewDescription } from './systemview-metadata';
import { SYSTEMVIEW_V4120_REFERENCE_BYTES } from './systemview-reference-fixture';

describe('SystemViewMetadataStore', () => {
  it('reconstructs system, interrupt, task, stack, module, resource, and marker metadata', () => {
    const decoder = new SystemViewEventDecoder();
    const store = new SystemViewMetadataStore();
    const batch = decoder.push(SYSTEMVIEW_V4120_REFERENCE_BYTES);
    for (const event of batch.events) store.apply(event);

    const snapshot = store.snapshot();
    expect(snapshot.cpuFrequency).toBe(168000000);
    expect(snapshot.ramBase).toBe(0x20000000);
    expect(snapshot.descriptionFields).toMatchObject({
      N: 'OrbitD02',
      D: 'STM32F407VET6',
      O: 'FreeRTOS',
    });
    expect(snapshot.interrupts).toEqual({ '15': 'SysTick' });
    expect(snapshot.tasks).toEqual([{
      taskId: 1,
      name: 'defaultTask',
      priority: 5,
      stackBase: 0x20001000,
      stackSize: 1024,
      stackUsage: 128,
    }]);
    expect(snapshot.markers).toEqual([{ markerId: 7 }]);
    expect(snapshot.diagnostics).toHaveLength(0);
  });

  it('keeps description parsing literal and preserves unknown keys', () => {
    expect(parseSystemViewDescription('N=App,D=Board,I#5=Timer,Custom=Value')).toEqual({
      fields: { N: 'App', D: 'Board', 'I#5': 'Timer', Custom: 'Value' },
      interrupts: { '5': 'Timer' },
    });
  });
});
