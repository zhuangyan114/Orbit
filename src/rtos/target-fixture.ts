import { compileFreeRtosLayout } from './freertos-layout';
import type { SnapshotRequest } from './snapshot-reader';
import { testCatalog } from './test-fixture';

export function syntheticTarget() {
  const layout = compileFreeRtosLayout(testCatalog(), 'test-elf'), bytes = Buffer.alloc(0x10000);
  const u32 = (address: number, value: number) => bytes.writeUInt32LE(value, address);
  const tasks = [{ address: 0x2000, name: 'current', list: 'ready[1]' }, { address: 0x2200, name: 'idle', list: 'ready[0]' },
    { address: 0x2400, name: 'delayed', list: 'xDelayedTaskList1' }, { address: 0x2600, name: 'suspended', list: 'xSuspendedTaskList' },
    { address: 0x2800, name: 'deleted', list: 'xTasksWaitingTermination' }];
  u32(0x1000, 0x2000); u32(0x1004, tasks.length);
  for (const list of layout.lists) {
    const sentinel = list.address + 16;
    u32(list.address + 4, 0); u32(list.address + 24, sentinel); u32(list.address + 28, sentinel);
  }
  const setList = (listName: string, addresses: number[], event = false) => {
    const list = layout.lists.find(list => list.name === listName)!, sentinel = list.address + 16;
    const nodes = addresses.map(address => address + (event ? 36 : 12));
    u32(list.address + 4, nodes.length); u32(list.address + 24, nodes[0] || sentinel); u32(list.address + 28, nodes.at(-1) || sentinel);
    nodes.forEach((node, index) => {
      u32(node + 8, nodes[index + 1] || sentinel); u32(node + 12, nodes[index - 1] || sentinel);
      u32(node + 16, addresses[index]); u32(node + 20, list.address);
    });
  };
  tasks.forEach((task, index) => {
    u32(task.address + 4, 0x8000 + index * 256 + 128); u32(task.address + 64, index === 0 ? 1 : 0);
    u32(task.address + 68, 0x8000 + index * 256); bytes.write(task.name, task.address + 72, 'utf8');
    u32(task.address + 88, 0x8000 + index * 256 + 252); u32(task.address + 92, index + 1);
    u32(task.address + 96, index === 0 ? 1 : 0); u32(task.address + 100, index * 100);
    bytes.fill(0xa5, 0x8000 + index * 256, 0x8000 + index * 256 + 64);
    setList(task.list, [task.address]);
  });
  const controller = new AbortController();
  const request: SnapshotRequest = { identity: { sessionId: 'session', sessionGeneration: 1, operationGeneration: 0, bootGeneration: 1,
    elfSha256: 'test-elf', layoutId: layout.layoutId }, sequence: 1, targetState: 'Halted', ram: [{ start: 0x1000, size: 0xf000 }],
    signal: controller.signal, read: async (address, size) => bytes.subarray(address, address + size) };
  return { layout, bytes, u32, tasks, setList, controller, request };
}
