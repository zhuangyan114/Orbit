import type { Capability, Consistency, Field, RtosSnapshot, TaskSnapshot } from '../../rtos/model';

export const RTOS_VIEW_SETTINGS_KEY = 'orbitRtosViewSettings';

export type RtosSubPage = 'tasks' | 'trace' | 'contexts';
export type RtosTaskSortKey = 'state' | 'priority' | 'name' | 'stack' | 'cpu' | 'address';
export type RtosSortDirection = 'asc' | 'desc';
export type RtosTaskStateFilter = 'all' | TaskSnapshot['state'];
export type RtosSessionPhase = 'none' | 'starting' | 'connected' | 'terminating';

export interface RtosCapabilitiesMap {
  layout: Capability;
  taskSnapshot: Capability;
  stackBounds: Capability;
  stackWatermark: Capability;
  runtimeCounters: Capability;
  runtimePercent: Capability;
}

export interface RtosCapabilitiesPayload {
  sessionId: string;
  sessionGeneration: number;
  operationGeneration: number;
  bootGeneration: number;
  elfSha256: string;
  layoutId: string;
  capabilities: RtosCapabilitiesMap;
}

export interface RtosViewSettings {
  version: 1;
  activePage: RtosSubPage;
  liveEnabled: boolean;
  liveIntervalMs: number;
  sortBy: RtosTaskSortKey;
  sortDir: RtosSortDirection;
  stateFilter: RtosTaskStateFilter;
  searchQuery: string;
  selectedTaskAddress: number | null;
  maxStackScanBytes: number;
  showDiagnostics: boolean;
}

export const DEFAULT_RTOS_VIEW_SETTINGS: RtosViewSettings = {
  version: 1,
  activePage: 'tasks',
  liveEnabled: false,
  liveIntervalMs: 500,
  sortBy: 'state',
  sortDir: 'asc',
  stateFilter: 'all',
  searchQuery: '',
  selectedTaskAddress: null,
  maxStackScanBytes: 4096,
  showDiagnostics: false,
};

export interface RtosSessionSummary {
  phase: RtosSessionPhase;
  sessionId?: string;
  sessionName?: string;
  sessionType?: string;
  device?: string;
  targetState?: 'Running' | 'Halted' | 'Unknown';
}

export interface RtosErrorSummary {
  errorCode?: string;
  message: string;
  at?: number;
}

export interface RtosPanelState {
  hostVersion: number;
  visible: boolean;
  session: RtosSessionSummary;
  settings: RtosViewSettings;
  capabilities: RtosCapabilitiesPayload | null;
  capabilitiesError: RtosErrorSummary | null;
  snapshot: RtosSnapshot | null;
  loading: { refresh: boolean; stackScan: boolean; capabilities: boolean };
  liveActive: boolean;
  lastError: RtosErrorSummary | null;
}

const VALID_PAGES = new Set<RtosSubPage>(['tasks', 'trace', 'contexts']);
const VALID_SORT_KEYS = new Set<RtosTaskSortKey>(['state', 'priority', 'name', 'stack', 'cpu', 'address']);
const VALID_STATES = new Set<RtosTaskStateFilter>(['all', 'running', 'ready', 'blocked', 'suspended', 'termination', 'unknown']);

export function clampLiveIntervalMs(value: unknown): number {
  const num = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(num)) return DEFAULT_RTOS_VIEW_SETTINGS.liveIntervalMs;
  return Math.max(200, Math.min(10000, Math.round(num)));
}

export function clampMaxStackScanBytes(value: unknown): number {
  const num = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(num)) return DEFAULT_RTOS_VIEW_SETTINGS.maxStackScanBytes;
  return Math.max(64, Math.min(16384, Math.round(num)));
}

export function sanitizeRtosViewSettings(input: unknown, base: RtosViewSettings = DEFAULT_RTOS_VIEW_SETTINGS): RtosViewSettings {
  const raw = input && typeof input === 'object' ? input as Record<string, unknown> : {};
  const activePage = VALID_PAGES.has(raw.activePage as RtosSubPage) ? raw.activePage as RtosSubPage : base.activePage;
  const sortBy = VALID_SORT_KEYS.has(raw.sortBy as RtosTaskSortKey) ? raw.sortBy as RtosTaskSortKey : base.sortBy;
  const sortDir: RtosSortDirection = raw.sortDir === 'desc' ? 'desc' : raw.sortDir === 'asc' ? 'asc' : base.sortDir;
  const stateFilter = VALID_STATES.has(raw.stateFilter as RtosTaskStateFilter) ? raw.stateFilter as RtosTaskStateFilter : base.stateFilter;
  const liveEnabled = typeof raw.liveEnabled === 'boolean' ? raw.liveEnabled : base.liveEnabled;
  const liveIntervalMs = raw.liveIntervalMs !== undefined ? clampLiveIntervalMs(raw.liveIntervalMs) : base.liveIntervalMs;
  const searchQuery = typeof raw.searchQuery === 'string' ? raw.searchQuery.slice(0, 128) : base.searchQuery;
  const selectedTaskAddress = raw.selectedTaskAddress === null
    ? null
    : typeof raw.selectedTaskAddress === 'number' && Number.isSafeInteger(raw.selectedTaskAddress) && raw.selectedTaskAddress > 0
      ? raw.selectedTaskAddress
      : base.selectedTaskAddress;
  const maxStackScanBytes = raw.maxStackScanBytes !== undefined ? clampMaxStackScanBytes(raw.maxStackScanBytes) : base.maxStackScanBytes;
  const showDiagnostics = typeof raw.showDiagnostics === 'boolean' ? raw.showDiagnostics : base.showDiagnostics;
  return {
    version: 1,
    activePage,
    liveEnabled,
    liveIntervalMs,
    sortBy,
    sortDir,
    stateFilter,
    searchQuery,
    selectedTaskAddress,
    maxStackScanBytes,
    showDiagnostics,
  };
}

const STATE_RANK: Record<TaskSnapshot['state'], number> = {
  running: 0,
  ready: 1,
  blocked: 2,
  suspended: 3,
  termination: 4,
  unknown: 5,
};

export function filterAndSortTasks(
  tasks: readonly TaskSnapshot[],
  settings: Pick<RtosViewSettings, 'stateFilter' | 'searchQuery' | 'sortBy' | 'sortDir'>,
): TaskSnapshot[] {
  const query = settings.searchQuery.trim().toLowerCase();
  const filtered = tasks.filter(task => {
    if (settings.stateFilter !== 'all' && task.state !== settings.stateFilter) return false;
    if (!query) return true;
    const name = task.name.available ? task.name.value.toLowerCase() : '';
    const hex = `0x${task.tcbAddress.toString(16)}`;
    const lists = task.lists.join(' ').toLowerCase();
    const num = task.creationNumber.available ? `#${task.creationNumber.value}` : '';
    return name.includes(query) || hex.includes(query) || lists.includes(query) || num.includes(query);
  });

  const dir = settings.sortDir === 'desc' ? -1 : 1;
  return [...filtered].sort((a, b) => {
    let cmp = 0;
    switch (settings.sortBy) {
      case 'state':
        cmp = (STATE_RANK[a.state] ?? 9) - (STATE_RANK[b.state] ?? 9);
        if (cmp === 0) cmp = (b.priority.available ? b.priority.value : -1) - (a.priority.available ? a.priority.value : -1);
        break;
      case 'priority':
        cmp = (a.priority.available ? a.priority.value : -1) - (b.priority.available ? b.priority.value : -1);
        break;
      case 'name': {
        const na = a.name.available ? a.name.value : '';
        const nb = b.name.available ? b.name.value : '';
        cmp = na.localeCompare(nb, undefined, { numeric: true });
        break;
      }
      case 'stack': {
        const ua = stackUsedRatio(a) ?? -1;
        const ub = stackUsedRatio(b) ?? -1;
        cmp = ua - ub;
        break;
      }
      case 'cpu': {
        const ca = a.runtime.percent.available ? a.runtime.percent.value : -1;
        const cb = b.runtime.percent.available ? b.runtime.percent.value : -1;
        cmp = ca - cb;
        break;
      }
      case 'address':
        cmp = a.tcbAddress - b.tcbAddress;
        break;
    }
    if (cmp !== 0) return cmp * dir;
    return a.tcbAddress - b.tcbAddress;
  });
}

export function stackUsedBytes(task: TaskSnapshot): number | undefined {
  if (!task.stack.capacityBytes.available || !task.stack.watermarkBytes.available) return undefined;
  return Math.max(0, task.stack.capacityBytes.value - task.stack.watermarkBytes.value);
}

export function stackUsedRatio(task: TaskSnapshot): number | undefined {
  const used = stackUsedBytes(task);
  if (used === undefined || !task.stack.capacityBytes.available || task.stack.capacityBytes.value <= 0) return undefined;
  return Math.min(1, used / task.stack.capacityBytes.value);
}

export function formatHex32(value: number): string {
  return `0x${(value >>> 0).toString(16).toUpperCase().padStart(8, '0')}`;
}

export function formatFieldValue<T>(field: Field<T>, formatter: (value: T) => string = String): string {
  return field.available ? formatter(field.value) : '—';
}

export function describeConsistency(consistency: Consistency): { label: string; tone: 'ok' | 'info' | 'warn' | 'error'; detail: string } {
  switch (consistency) {
    case 'halted-consistent':
      return { label: '暂停一致', tone: 'ok', detail: '目标处于暂停状态，内核链表与前后锚点一致。' };
    case 'live-best-effort':
      return { label: '运行态尽力采集', tone: 'info', detail: '目标运行中采集，前后锚点一致但多轮读取非原子快照。' };
    case 'partial':
      return { label: '部分结果', tone: 'warn', detail: '采集期间列表变化、短读或预算受限，请结合逐行证据与诊断信息核对。' };
    case 'stale':
      return { label: '过期快照', tone: 'warn', detail: '目标当前不可读，保留同启动代次内最近一次有效快照。' };
    case 'unavailable':
      return { label: '不可用', tone: 'error', detail: '当前无法生成有效任务快照。' };
  }
}

export function describeDiagnosticIssue(error: RtosErrorSummary | null): { title: string; hints: string[] } | null {
  if (!error) return null;
  switch (error.errorCode) {
    case 'RtosNotDetected':
      return {
        title: '未检测到 FreeRTOS 内核符号',
        hints: [
          '确认固件已链接 FreeRTOS 内核且未剥离核心符号（pxCurrentTCB、uxCurrentNumberOfTasks、pxReadyTasksLists）。',
          '当前首版 RTOS 面板仅支持单核 Cortex-M FreeRTOS；裸机或未支持内核会保留此提示。',
        ],
      };
    case 'DwarfUnavailable':
      return {
        title: '缺少 DWARF 调试信息',
        hints: [
          '使用 -g / -g3 编译固件并保留 .debug_info 段，不要对加载的 ELF 执行 strip。',
          'Orbit 仅依据 ELF 中的实际 DWARF 类型偏移解析 TCB 与链表，不使用固定偏移猜解。',
        ],
      };
    case 'LayoutIncomplete':
    case 'LayoutAmbiguous':
      return {
        title: error.errorCode === 'LayoutAmbiguous' ? 'FreeRTOS 内核符号或类型布局存在歧义' : 'FreeRTOS 类型布局不完整',
        hints: [
          error.message,
          '请核对编译产物是否包含完整的 tasks.c / list.c DWARF 定义且内核根全局变量唯一。',
        ],
      };
    case 'UnsupportedCapability':
      return {
        title: '目标内存范围未注册或能力受限',
        hints: [
          error.message,
          '检查 launch 配置中的 device 型号是否与目标芯片一致。',
        ],
      };
    default:
      return {
        title: error.errorCode ? `快照错误 (${error.errorCode})` : '快照暂不可用',
        hints: [error.message],
      };
  }
}
