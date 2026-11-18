/**
 * SEGGER SystemView 3.32.0 协议常量、短事件/显式长度 schema 与 FreeRTOS API 映射。
 *
 * 依据仓库固定源码：
 * - `scripts/rtos/fixtures/vendor/systemview/SYSVIEW/SEGGER_SYSVIEW.h` (3.32.0)
 * - `scripts/rtos/fixtures/vendor/systemview/SYSVIEW/SEGGER_SYSVIEW.c`
 * - `scripts/rtos/fixtures/vendor/systemview/SYSVIEW/SEGGER_SYSVIEW_Int.h`
 * - `scripts/rtos/fixtures/vendor/systemview/FreeRTOSV10/SEGGER_SYSVIEW_FreeRTOS.h`
 */

export const SYSTEMVIEW_PROTOCOL_VERSION = '3.32.0';
export const SYSTEMVIEW_SYNC_BYTE_COUNT = 10;
export const SYSTEMVIEW_SHORT_ID_MAX = 23;
export const SYSTEMVIEW_EXPLICIT_LEN_MIN_ID = 24;
export const SYSTEMVIEW_MAX_VARINT_BYTES = 5;
export const SYSTEMVIEW_VARINT_FIFTH_BYTE_MAX = 0x0f;
export const SYSTEMVIEW_FREERTOS_API_OFFSET = 32;
export const SYSTEMVIEW_MODULE_EVENT_OFFSET = 512;
export const SYSTEMVIEW_USER_EVENT_MIN = 1024;
export const SYSTEMVIEW_USER_EVENT_MAX = 2047;
export const SYSTEMVIEW_MAX_PROTOCOL_STRING_BYTES = 65535;

export const SYSTEMVIEW_EVENT_IDS = {
  NOP: 0,
  OVERFLOW: 1,
  ISR_ENTER: 2,
  ISR_EXIT: 3,
  TASK_START_EXEC: 4,
  TASK_STOP_EXEC: 5,
  TASK_START_READY: 6,
  TASK_STOP_READY: 7,
  TASK_CREATE: 8,
  TASK_INFO: 9,
  TRACE_START: 10,
  TRACE_STOP: 11,
  SYSTIME_CYCLES: 12,
  SYSTIME_US: 13,
  SYSDESC: 14,
  MARK_START: 15,
  MARK_STOP: 16,
  IDLE: 17,
  ISR_TO_SCHEDULER: 18,
  TIMER_ENTER: 19,
  TIMER_EXIT: 20,
  STACK_INFO: 21,
  MODULEDESC: 22,
  DATA_SAMPLE: 23,
  INIT: 24,
  NAME_RESOURCE: 25,
  PRINT_FORMATTED: 26,
  NUMMODULES: 27,
  END_CALL: 28,
  TASK_TERMINATE: 29,
  EX: 31,
} as const;

export const SYSTEMVIEW_EVENT_NAMES: Readonly<Record<number, string>> = {
  0: 'NOP',
  1: 'OVERFLOW',
  2: 'ISR_ENTER',
  3: 'ISR_EXIT',
  4: 'TASK_START_EXEC',
  5: 'TASK_STOP_EXEC',
  6: 'TASK_START_READY',
  7: 'TASK_STOP_READY',
  8: 'TASK_CREATE',
  9: 'TASK_INFO',
  10: 'TRACE_START',
  11: 'TRACE_STOP',
  12: 'SYSTIME_CYCLES',
  13: 'SYSTIME_US',
  14: 'SYSDESC',
  15: 'MARK_START',
  16: 'MARK_STOP',
  17: 'IDLE',
  18: 'ISR_TO_SCHEDULER',
  19: 'TIMER_ENTER',
  20: 'TIMER_EXIT',
  21: 'STACK_INFO',
  22: 'MODULEDESC',
  23: 'DATA_SAMPLE',
  24: 'INIT',
  25: 'NAME_RESOURCE',
  26: 'PRINT_FORMATTED',
  27: 'NUMMODULES',
  28: 'END_CALL',
  29: 'TASK_TERMINATE',
  31: 'EX',
};

export const SYSTEMVIEW_EX_IDS = {
  MARK: 0,
  NAME_MARKER: 1,
  HEAP_DEFINE: 2,
  HEAP_ALLOC: 3,
  HEAP_ALLOC_EX: 4,
  HEAP_FREE: 5,
  REGISTER_DATA: 6,
  PRINT_ELF: 7,
} as const;

export const SYSTEMVIEW_EX_NAMES: Readonly<Record<number, string>> = {
  0: 'EX_MARK',
  1: 'EX_NAME_MARKER',
  2: 'EX_HEAP_DEFINE',
  3: 'EX_HEAP_ALLOC',
  4: 'EX_HEAP_ALLOC_EX',
  5: 'EX_HEAP_FREE',
  6: 'EX_REGISTER_DATA',
  7: 'EX_PRINT_ELF',
};

export const SYSTEMVIEW_COMMAND_IDS = {
  START: 1,
  STOP: 2,
  GET_SYSTIME: 3,
  GET_TASKLIST: 4,
  GET_SYSDESC: 5,
  GET_NUMMODULES: 6,
  GET_MODULEDESC: 7,
  HEARTBEAT: 127,
  GET_MODULE: 128,
} as const;

export type ShortFieldKind = 'u32' | 'string';

export interface ShortFieldDef {
  readonly name: string;
  readonly kind: ShortFieldKind;
}

export interface ShortEventSchema {
  readonly eventId: number;
  readonly name: string;
  readonly fields: readonly ShortFieldDef[];
}

/**
 * 固定 3.32.0 源码中的短事件 schema（ID 1..23，不含长度字节）。
 * ID 0 为 NOP/SYNC 保留字节，不作为常规短包 schema。
 */
export const SYSTEMVIEW_SHORT_SCHEMAS: Readonly<Record<number, ShortEventSchema>> = {
  1: { eventId: 1, name: 'OVERFLOW', fields: [{ name: 'dropCount', kind: 'u32' }] },
  2: { eventId: 2, name: 'ISR_ENTER', fields: [{ name: 'irqId', kind: 'u32' }] },
  3: { eventId: 3, name: 'ISR_EXIT', fields: [] },
  4: { eventId: 4, name: 'TASK_START_EXEC', fields: [{ name: 'shrunkTaskId', kind: 'u32' }] },
  5: { eventId: 5, name: 'TASK_STOP_EXEC', fields: [] },
  6: { eventId: 6, name: 'TASK_START_READY', fields: [{ name: 'shrunkTaskId', kind: 'u32' }] },
  7: {
    eventId: 7,
    name: 'TASK_STOP_READY',
    fields: [
      { name: 'shrunkTaskId', kind: 'u32' },
      { name: 'cause', kind: 'u32' },
    ],
  },
  8: { eventId: 8, name: 'TASK_CREATE', fields: [{ name: 'shrunkTaskId', kind: 'u32' }] },
  9: {
    eventId: 9,
    name: 'TASK_INFO',
    fields: [
      { name: 'shrunkTaskId', kind: 'u32' },
      { name: 'priority', kind: 'u32' },
      { name: 'name', kind: 'string' },
    ],
  },
  10: { eventId: 10, name: 'TRACE_START', fields: [] },
  11: { eventId: 11, name: 'TRACE_STOP', fields: [] },
  12: { eventId: 12, name: 'SYSTIME_CYCLES', fields: [{ name: 'cycles', kind: 'u32' }] },
  13: {
    eventId: 13,
    name: 'SYSTIME_US',
    fields: [
      { name: 'systimeLow', kind: 'u32' },
      { name: 'systimeHigh', kind: 'u32' },
    ],
  },
  14: { eventId: 14, name: 'SYSDESC', fields: [{ name: 'description', kind: 'string' }] },
  15: { eventId: 15, name: 'MARK_START', fields: [{ name: 'markerId', kind: 'u32' }] },
  16: { eventId: 16, name: 'MARK_STOP', fields: [{ name: 'markerId', kind: 'u32' }] },
  17: { eventId: 17, name: 'IDLE', fields: [] },
  18: { eventId: 18, name: 'ISR_TO_SCHEDULER', fields: [] },
  19: { eventId: 19, name: 'TIMER_ENTER', fields: [{ name: 'shrunkTimerId', kind: 'u32' }] },
  20: { eventId: 20, name: 'TIMER_EXIT', fields: [] },
  21: {
    eventId: 21,
    name: 'STACK_INFO',
    fields: [
      { name: 'shrunkTaskId', kind: 'u32' },
      { name: 'stackBase', kind: 'u32' },
      { name: 'stackSize', kind: 'u32' },
      { name: 'stackUsage', kind: 'u32' },
    ],
  },
  22: {
    eventId: 22,
    name: 'MODULEDESC',
    fields: [
      { name: 'moduleId', kind: 'u32' },
      { name: 'eventOffset', kind: 'u32' },
      { name: 'description', kind: 'string' },
    ],
  },
  23: {
    eventId: 23,
    name: 'DATA_SAMPLE',
    fields: [
      { name: 'dataId', kind: 'u32' },
      { name: 'rawValueBits', kind: 'u32' },
    ],
  },
};

export const DEFAULT_SHORT_SCHEMA_IDS: ReadonlySet<number> = new Set(
  Object.keys(SYSTEMVIEW_SHORT_SCHEMAS).map(Number),
);

/**
 * 依据 `SEGGER_SYSVIEW_FreeRTOS.h` (apiID_OFFSET = 32) 冻结的 apiID 1..111 名称表。
 */
export const FREERTOS_API_NAMES: Readonly<Record<number, string>> = {
  1: 'vTaskAllocateMPURegions',
  2: 'vTaskDelete',
  3: 'vTaskDelay',
  4: 'vTaskDelayUntil',
  5: 'uxTaskPriorityGet',
  6: 'uxTaskPriorityGetFromISR',
  7: 'eTaskGetState',
  8: 'vTaskPrioritySet',
  9: 'vTaskSuspend',
  10: 'vTaskResume',
  11: 'xTaskResumeFromISR',
  12: 'vTaskStartScheduler',
  13: 'vTaskEndScheduler',
  14: 'vTaskSuspendAll',
  15: 'xTaskResumeAll',
  16: 'xTaskGetTickCount',
  17: 'xTaskGetTickCountFromISR',
  18: 'uxTaskGetNumberOfTasks',
  19: 'pcTaskGetTaskName',
  20: 'uxTaskGetStackHighWaterMark',
  21: 'vTaskSetApplicationTaskTag',
  22: 'xTaskGetApplicationTaskTag',
  23: 'vTaskSetThreadLocalStoragePointer',
  24: 'pvTaskGetThreadLocalStoragePointer',
  25: 'xTaskCallApplicationTaskHook',
  26: 'xTaskGetIdleTaskHandle',
  27: 'uxTaskGetSystemState',
  28: 'vTaskList',
  29: 'vTaskGetRunTimeStats',
  30: 'xTaskGenericNotify',
  31: 'xTaskGenericNotifyFromISR',
  32: 'xTaskNotifyWait',
  33: 'vTaskNotifyGiveFromISR',
  34: 'ulTaskNotifyTake',
  35: 'xTaskNotifyStateClear',
  36: 'xTaskGetCurrentTaskHandle',
  37: 'vTaskSetTimeOutState',
  38: 'xTaskCheckForTimeOut',
  39: 'vTaskMissedYield',
  40: 'xTaskGetSchedulerState',
  41: 'vTaskPriorityInherit',
  42: 'xTaskPriorityDisinherit',
  43: 'xTaskGenericCreate',
  44: 'uxTaskGetTaskNumber',
  45: 'vTaskSetTaskNumber',
  46: 'vTaskStepTick',
  47: 'eTaskConfirmSleepModeStatus',
  48: 'xTimerCreate',
  49: 'pvTimerGetTimerID',
  50: 'vTimerSetTimerID',
  51: 'xTimerIsTimerActive',
  52: 'xTimerGetTimerDaemonTaskHandle',
  53: 'xTimerPendFunctionCallFromISR',
  54: 'xTimerPendFunctionCall',
  55: 'pcTimerGetTimerName',
  56: 'xTimerCreateTimerTask',
  57: 'xTimerGenericCommand',
  58: 'xQueueGenericSend',
  59: 'xQueuePeekFromISR',
  60: 'xQueueGenericReceive',
  61: 'uxQueueMessagesWaiting',
  62: 'uxQueueSpacesAvailable',
  63: 'vQueueDelete',
  64: 'xQueueGenericSendFromISR',
  65: 'xQueueGiveFromISR',
  66: 'xQueueReceiveFromISR',
  67: 'xQueueIsQueueEmptyFromISR',
  68: 'xQueueIsQueueFullFromISR',
  69: 'uxQueueMessagesWaitingFromISR',
  70: 'xQueueAltGenericSend',
  71: 'xQueueAltGenericReceive',
  72: 'xQueueCRSendFromISR',
  73: 'xQueueCRReceiveFromISR',
  74: 'xQueueCRSend',
  75: 'xQueueCRReceive',
  76: 'xQueueCreateMutex',
  77: 'xQueueCreateCountingSemaphore',
  78: 'xQueueGetMutexHolder',
  79: 'xQueueTakeMutexRecursive',
  80: 'xQueueGiveMutexRecursive',
  81: 'vQueueAddToRegistry',
  82: 'vQueueUnregisterQueue',
  83: 'xQueueGenericCreate',
  84: 'xQueueCreateSet',
  85: 'xQueueAddToSet',
  86: 'xQueueRemoveFromSet',
  87: 'xQueueSelectFromSet',
  88: 'xQueueSelectFromSetFromISR',
  89: 'xQueueGenericReset',
  90: 'vListInitialise',
  91: 'vListInitialiseItem',
  92: 'vListInsert',
  93: 'vListInsertEnd',
  94: 'uxListRemove',
  95: 'xEventGroupCreate',
  96: 'xEventGroupWaitBits',
  97: 'xEventGroupClearBits',
  98: 'xEventGroupClearBitsFromISR',
  99: 'xEventGroupSetBits',
  100: 'xEventGroupSetBitsFromISR',
  101: 'xEventGroupSync',
  102: 'xEventGroupGetBitsFromISR',
  103: 'vEventGroupDelete',
  104: 'uxEventGroupGetNumber',
  105: 'xStreamBufferCreate',
  106: 'vStreamBufferDelete',
  107: 'xStreamBufferReset',
  108: 'xStreamBufferSend',
  109: 'xStreamBufferSendFromISR',
  110: 'xStreamBufferReceive',
  111: 'xStreamBufferReceiveFromISR',
};

export interface FreeRtosParamDef {
  readonly name: string;
  readonly kind: 'shrunk-id' | 'u32';
}

/**
 * 依据 `SEGGER_SYSVIEW_FreeRTOS.h` 中 `trace*` 宏实际编码的参数顺序。
 * 区分经 `SEGGER_SYSVIEW_ShrinkId` 压缩的句柄和未压缩的原始 U32。
 */
export const FREERTOS_TRACE_MACRO_PARAMS: Readonly<Record<number, readonly FreeRtosParamDef[]>> = {
  2: [{ name: 'taskId', kind: 'shrunk-id' }],
  3: [{ name: 'ticksToDelay', kind: 'u32' }],
  4: [],
  8: [
    { name: 'taskId', kind: 'shrunk-id' },
    { name: 'newPriority', kind: 'u32' },
  ],
  9: [{ name: 'taskId', kind: 'shrunk-id' }],
  10: [{ name: 'taskId', kind: 'shrunk-id' }],
  11: [{ name: 'taskId', kind: 'shrunk-id' }],
  30: [
    { name: 'taskId', kind: 'shrunk-id' },
    { name: 'value', kind: 'u32' },
    { name: 'action', kind: 'u32' },
    { name: 'previousValuePtr', kind: 'u32' },
  ],
  31: [
    { name: 'taskId', kind: 'shrunk-id' },
    { name: 'value', kind: 'u32' },
    { name: 'action', kind: 'u32' },
    { name: 'previousValuePtr', kind: 'u32' },
    { name: 'higherPriorityTaskWokenPtr', kind: 'u32' },
  ],
  32: [
    { name: 'bitsToClearOnEntry', kind: 'u32' },
    { name: 'bitsToClearOnExit', kind: 'u32' },
    { name: 'notificationValuePtr', kind: 'u32' },
    { name: 'ticksToWait', kind: 'u32' },
  ],
  33: [
    { name: 'taskId', kind: 'shrunk-id' },
    { name: 'higherPriorityTaskWokenPtr', kind: 'u32' },
  ],
  34: [
    { name: 'clearCountOnExit', kind: 'u32' },
    { name: 'ticksToWait', kind: 'u32' },
  ],
  41: [{ name: 'mutexHolderPtr', kind: 'u32' }],
  42: [{ name: 'mutexHolderPtr', kind: 'u32' }],
  46: [{ name: 'ticksToJump', kind: 'u32' }],
  58: [
    { name: 'queueId', kind: 'shrunk-id' },
    { name: 'itemPtr', kind: 'u32' },
    { name: 'ticksToWait', kind: 'u32' },
    { name: 'copyPosition', kind: 'u32' },
  ],
  59: [
    { name: 'queueId', kind: 'shrunk-id' },
    { name: 'bufferId', kind: 'shrunk-id' },
  ],
  60: [
    { name: 'queueId', kind: 'shrunk-id' },
    { name: 'bufferOrZeroId', kind: 'shrunk-id' },
    { name: 'ticksToWait', kind: 'u32' },
    { name: 'isQueue', kind: 'u32' },
  ],
  63: [{ name: 'queueId', kind: 'shrunk-id' }],
  64: [
    { name: 'queueId', kind: 'shrunk-id' },
    { name: 'higherPriorityTaskWokenPtr', kind: 'u32' },
  ],
  66: [
    { name: 'queueId', kind: 'shrunk-id' },
    { name: 'bufferId', kind: 'shrunk-id' },
    { name: 'higherPriorityTaskWokenPtr', kind: 'u32' },
  ],
  81: [
    { name: 'queueId', kind: 'shrunk-id' },
    { name: 'queueNamePtr', kind: 'u32' },
  ],
  83: [
    { name: 'queueLength', kind: 'u32' },
    { name: 'itemSize', kind: 'u32' },
    { name: 'queueType', kind: 'u32' },
  ],
  105: [
    { name: 'isMessageBuffer', kind: 'u32' },
    { name: 'streamBufferPtr', kind: 'u32' },
  ],
  106: [{ name: 'streamBufferPtr', kind: 'u32' }],
  107: [{ name: 'streamBufferPtr', kind: 'u32' }],
  108: [
    { name: 'streamBufferPtr', kind: 'u32' },
    { name: 'bytesSent', kind: 'u32' },
  ],
  109: [
    { name: 'streamBufferPtr', kind: 'u32' },
    { name: 'bytesSent', kind: 'u32' },
  ],
  110: [
    { name: 'streamBufferPtr', kind: 'u32' },
    { name: 'bytesReceived', kind: 'u32' },
  ],
  111: [
    { name: 'streamBufferPtr', kind: 'u32' },
    { name: 'bytesReceived', kind: 'u32' },
  ],
};

export type IdResolutionStatus =
  | 'resolved'
  | 'unresolved-missing-init'
  | 'invalid-shift'
  | 'address-overflow';

export interface IdExpansionResult {
  readonly status: IdResolutionStatus;
  readonly value?: number;
}

/**
 * 反向还原经 `SHRINK_ID(Id) = ((Id - RAMBaseAddress) >> ID_SHIFT)` 压缩的资源 ID。
 * 使用 bigint 防 32 位地址与移位溢出；超出 uint32 范围时显式拒绝。
 */
export function expandShrunkId(
  shrunkId: number,
  ramBaseAddress: number | undefined,
  idShift: number | undefined,
): IdExpansionResult {
  if (ramBaseAddress === undefined || idShift === undefined) {
    return { status: 'unresolved-missing-init' };
  }
  if (!Number.isInteger(idShift) || idShift < 0 || idShift > 31) {
    return { status: 'invalid-shift' };
  }
  if (!Number.isInteger(shrunkId) || shrunkId < 0 || shrunkId > 0xffffffff) {
    return { status: 'address-overflow' };
  }
  if (!Number.isInteger(ramBaseAddress) || ramBaseAddress < 0 || ramBaseAddress > 0xffffffff) {
    return { status: 'address-overflow' };
  }
  const expanded = BigInt(ramBaseAddress) + (BigInt(shrunkId) << BigInt(idShift));
  if (expanded < 0n || expanded > 0xffffffffn) {
    return { status: 'address-overflow' };
  }
  return { status: 'resolved', value: Number(expanded) };
}

export interface SysDescEntry {
  readonly key: string;
  readonly value: string;
}

export interface ParsedSysDesc {
  readonly rawText: string;
  readonly appName?: string;
  readonly deviceName?: string;
  readonly osName?: string;
  readonly coreName?: string;
  readonly interrupts: Readonly<Record<number, string>>;
  readonly entries: readonly SysDescEntry[];
  readonly malformedItems: readonly string[];
}

/**
 * 解析 `SYSDESC` 描述字符串（例如 `N=App,D=STM32H723,O=FreeRTOS,C=Cortex-M7,I#15=SysTick`）。
 */
export function parseSystemDescription(rawText: string): ParsedSysDesc {
  const entries: SysDescEntry[] = [];
  const interrupts: Record<number, string> = {};
  const malformedItems: string[] = [];
  let appName: string | undefined;
  let deviceName: string | undefined;
  let osName: string | undefined;
  let coreName: string | undefined;

  if (rawText.length > 0) {
    const parts = rawText.split(',');
    for (const part of parts) {
      const trimmed = part.trim();
      if (trimmed.length === 0) {
        continue;
      }
      const eq = trimmed.indexOf('=');
      if (eq <= 0) {
        malformedItems.push(trimmed);
        continue;
      }
      const key = trimmed.slice(0, eq).trim();
      const value = trimmed.slice(eq + 1).trim();
      entries.push({ key, value });
      if (key === 'N') {
        appName = value;
      } else if (key === 'D') {
        deviceName = value;
      } else if (key === 'O') {
        osName = value;
      } else if (key === 'C') {
        coreName = value;
      } else if (key.startsWith('I#')) {
        const irqText = key.slice(2);
        const irqId = Number(irqText);
        if (/^\d+$/.test(irqText) && Number.isInteger(irqId) && irqId >= 0 && irqId <= 0xffffffff) {
          interrupts[irqId] = value;
        } else {
          malformedItems.push(trimmed);
        }
      }
    }
  }

  return {
    rawText,
    appName,
    deviceName,
    osName,
    coreName,
    interrupts,
    entries,
    malformedItems,
  };
}

const floatBuf = new ArrayBuffer(4);
const floatView = new DataView(floatBuf);

export function decodeFloatBits(u32: number): number {
  floatView.setUint32(0, u32 >>> 0, true);
  return floatView.getFloat32(0, true);
}
