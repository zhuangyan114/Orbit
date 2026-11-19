import type {
  Capability,
  Consistency,
  Field,
  QueueObjectKind,
  RtosSnapshot,
  SyncObjectSnapshot,
  TaskSnapshot,
  TimerListState,
  TimerSnapshot,
} from '../../rtos/model';
import type { TraceRecordingMode } from '../../trace/trace-recording-coordinator';
import type { TracePanelState, TraceTimeUnit } from './trace-timeline-state';

export const RTOS_VIEW_SETTINGS_KEY = 'orbitRtosViewSettings';

export type RtosSubPage = 'tasks' | 'trace' | 'contexts';
export type RtosTasksSubTab = 'tasks' | 'objects' | 'timers';
export type RtosObjectKindFilter = 'all' | 'queue' | 'mutex' | 'semaphore' | 'issues';
export type RtosTimerFilter = 'all' | 'active' | 'stopped';
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
  objects?: Capability;
  timers?: Capability;
  heap?: Capability;
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
  tasksSubTab: RtosTasksSubTab;
  liveEnabled: boolean;
  liveIntervalMs: number;
  includeObjectsInLive: boolean;
  sortBy: RtosTaskSortKey;
  sortDir: RtosSortDirection;
  stateFilter: RtosTaskStateFilter;
  searchQuery: string;
  objectKindFilter: RtosObjectKindFilter;
  objectSearchQuery: string;
  timerFilter: RtosTimerFilter;
  timerSearchQuery: string;
  selectedTaskAddress: number | null;
  selectedObjectAddress: number | null;
  maxStackScanBytes: number;
  detailBudgetBytes: number;
  showDiagnostics: boolean;
  traceMode: TraceRecordingMode;
  traceAutoFollow: boolean;
  traceTimeUnit: TraceTimeUnit;
}

export const DEFAULT_RTOS_VIEW_SETTINGS: RtosViewSettings = {
  version: 1,
  activePage: 'tasks',
  tasksSubTab: 'tasks',
  liveEnabled: false,
  liveIntervalMs: 500,
  includeObjectsInLive: false,
  sortBy: 'state',
  sortDir: 'asc',
  stateFilter: 'all',
  searchQuery: '',
  objectKindFilter: 'all',
  objectSearchQuery: '',
  timerFilter: 'all',
  timerSearchQuery: '',
  selectedTaskAddress: null,
  selectedObjectAddress: null,
  maxStackScanBytes: 4096,
  detailBudgetBytes: 65536,
  showDiagnostics: false,
  traceMode: 'continuous',
  traceAutoFollow: true,
  traceTimeUnit: 'ns',
};

export const INITIAL_TRACE_PANEL_STATE: TracePanelState = {
  targetProbe: null,
  probing: false,
  selectedRecordId: null,
  records: [],
  lastActionMessage: null,
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
  trace?: TracePanelState;
}

const VALID_PAGES = new Set<RtosSubPage>(['tasks', 'trace', 'contexts']);
const VALID_SUB_TABS = new Set<RtosTasksSubTab>(['tasks', 'objects', 'timers']);
const VALID_OBJ_FILTERS = new Set<RtosObjectKindFilter>(['all', 'queue', 'mutex', 'semaphore', 'issues']);
const VALID_TIMER_FILTERS = new Set<RtosTimerFilter>(['all', 'active', 'stopped']);
const VALID_SORT_KEYS = new Set<RtosTaskSortKey>(['state', 'priority', 'name', 'stack', 'cpu', 'address']);
const VALID_STATES = new Set<RtosTaskStateFilter>(['all', 'running', 'ready', 'blocked', 'suspended', 'termination', 'unknown']);
const VALID_TRACE_MODES = new Set<TraceRecordingMode>(['continuous', 'single-shot', 'post-mortem']);
const VALID_TRACE_UNITS = new Set<TraceTimeUnit>(['ns', 'relative-ns', 'absolute-ticks', 'relative-ticks']);

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

export function clampDetailBudgetBytes(value: unknown): number {
  const num = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(num)) return DEFAULT_RTOS_VIEW_SETTINGS.detailBudgetBytes;
  return Math.max(4096, Math.min(131072, Math.round(num)));
}

export function sanitizeRtosViewSettings(input: unknown, base: RtosViewSettings = DEFAULT_RTOS_VIEW_SETTINGS): RtosViewSettings {
  const raw = input && typeof input === 'object' ? input as Record<string, unknown> : {};
  const activePage = VALID_PAGES.has(raw.activePage as RtosSubPage) ? raw.activePage as RtosSubPage : base.activePage;
  const tasksSubTab = VALID_SUB_TABS.has(raw.tasksSubTab as RtosTasksSubTab) ? raw.tasksSubTab as RtosTasksSubTab : base.tasksSubTab;
  const sortBy = VALID_SORT_KEYS.has(raw.sortBy as RtosTaskSortKey) ? raw.sortBy as RtosTaskSortKey : base.sortBy;
  const sortDir: RtosSortDirection = raw.sortDir === 'desc' ? 'desc' : raw.sortDir === 'asc' ? 'asc' : base.sortDir;
  const stateFilter = VALID_STATES.has(raw.stateFilter as RtosTaskStateFilter) ? raw.stateFilter as RtosTaskStateFilter : base.stateFilter;
  const objectKindFilter = VALID_OBJ_FILTERS.has(raw.objectKindFilter as RtosObjectKindFilter) ? raw.objectKindFilter as RtosObjectKindFilter : base.objectKindFilter;
  const timerFilter = VALID_TIMER_FILTERS.has(raw.timerFilter as RtosTimerFilter) ? raw.timerFilter as RtosTimerFilter : base.timerFilter;
  const liveEnabled = typeof raw.liveEnabled === 'boolean' ? raw.liveEnabled : base.liveEnabled;
  const liveIntervalMs = raw.liveIntervalMs !== undefined ? clampLiveIntervalMs(raw.liveIntervalMs) : base.liveIntervalMs;
  const includeObjectsInLive = typeof raw.includeObjectsInLive === 'boolean' ? raw.includeObjectsInLive : base.includeObjectsInLive;
  const searchQuery = typeof raw.searchQuery === 'string' ? raw.searchQuery.slice(0, 128) : base.searchQuery;
  const objectSearchQuery = typeof raw.objectSearchQuery === 'string' ? raw.objectSearchQuery.slice(0, 128) : base.objectSearchQuery;
  const timerSearchQuery = typeof raw.timerSearchQuery === 'string' ? raw.timerSearchQuery.slice(0, 128) : base.timerSearchQuery;
  const selectedTaskAddress = raw.selectedTaskAddress === null
    ? null
    : typeof raw.selectedTaskAddress === 'number' && Number.isSafeInteger(raw.selectedTaskAddress) && raw.selectedTaskAddress > 0
      ? raw.selectedTaskAddress
      : base.selectedTaskAddress;
  const selectedObjectAddress = raw.selectedObjectAddress === null
    ? null
    : typeof raw.selectedObjectAddress === 'number' && Number.isSafeInteger(raw.selectedObjectAddress) && raw.selectedObjectAddress > 0
      ? raw.selectedObjectAddress
      : base.selectedObjectAddress;
  const maxStackScanBytes = raw.maxStackScanBytes !== undefined ? clampMaxStackScanBytes(raw.maxStackScanBytes) : base.maxStackScanBytes;
  const detailBudgetBytes = raw.detailBudgetBytes !== undefined ? clampDetailBudgetBytes(raw.detailBudgetBytes) : base.detailBudgetBytes;
  const showDiagnostics = typeof raw.showDiagnostics === 'boolean' ? raw.showDiagnostics : base.showDiagnostics;
  const traceMode = VALID_TRACE_MODES.has(raw.traceMode as TraceRecordingMode) ? raw.traceMode as TraceRecordingMode : base.traceMode;
  const traceAutoFollow = typeof raw.traceAutoFollow === 'boolean' ? raw.traceAutoFollow : base.traceAutoFollow;
  const traceTimeUnit = VALID_TRACE_UNITS.has(raw.traceTimeUnit as TraceTimeUnit) ? raw.traceTimeUnit as TraceTimeUnit : base.traceTimeUnit;
  return {
    version: 1,
    activePage,
    tasksSubTab,
    liveEnabled,
    liveIntervalMs,
    includeObjectsInLive,
    sortBy,
    sortDir,
    stateFilter,
    searchQuery,
    objectKindFilter,
    objectSearchQuery,
    timerFilter,
    timerSearchQuery,
    selectedTaskAddress,
    selectedObjectAddress,
    maxStackScanBytes,
    detailBudgetBytes,
    showDiagnostics,
    traceMode,
    traceAutoFollow,
    traceTimeUnit,
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

export function formatDurationMs(value: number | undefined, decimals = 0): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
  const clamped = Math.max(0, value);
  return decimals > 0 ? clamped.toFixed(decimals) : String(Math.round(clamped));
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

export function objectKindLabel(kind: QueueObjectKind): string {
  switch (kind) {
    case 'queue': return 'Queue';
    case 'mutex': return 'Mutex';
    case 'recursive-mutex': return 'Recursive Mutex';
    case 'binary-semaphore': return 'Binary Sem';
    case 'counting-semaphore': return 'Counting Sem';
    case 'queue-set': return 'Queue Set';
    default: return 'Unknown';
  }
}

function matchesHex(address: number, needle: string): boolean {
  return formatHex32(address).toLowerCase().includes(needle) || address.toString(16).includes(needle);
}

export function filterSyncObjects(
  objects: readonly SyncObjectSnapshot[],
  kindFilter: RtosObjectKindFilter,
  query: string,
): SyncObjectSnapshot[] {
  const needle = query.trim().toLowerCase();
  return objects.filter(obj => {
    if (kindFilter === 'queue' && obj.kind !== 'queue' && obj.kind !== 'queue-set') return false;
    if (kindFilter === 'mutex' && obj.kind !== 'mutex' && obj.kind !== 'recursive-mutex') return false;
    if (kindFilter === 'semaphore' && obj.kind !== 'binary-semaphore' && obj.kind !== 'counting-semaphore') return false;
    if (kindFilter === 'issues' && obj.health === 'valid' && obj.waitListEvidence !== 'corrupt') return false;
    if (!needle) return true;
    const name = obj.name.available ? obj.name.value.toLowerCase() : '';
    const sym = (obj.symbolName || '').toLowerCase();
    const holder = obj.holder?.taskName?.toLowerCase() || '';
    const kind = objectKindLabel(obj.kind).toLowerCase();
    return name.includes(needle) || sym.includes(needle) || matchesHex(obj.address, needle) || holder.includes(needle) || kind.includes(needle);
  });
}

export function timerStateLabel(state: TimerListState): string {
  switch (state) {
    case 'active-current': return '当前活动';
    case 'active-overflow': return '溢出列表';
    case 'stopped-global': return '全局已停';
    default: return '状态待定';
  }
}

export function filterTimers(
  timers: readonly TimerSnapshot[],
  timerFilter: RtosTimerFilter,
  query: string,
): TimerSnapshot[] {
  const needle = query.trim().toLowerCase();
  return timers.filter(timer => {
    const isActive = timer.listState === 'active-current' || timer.listState === 'active-overflow' || (timer.active.available && timer.active.value);
    if (timerFilter === 'active' && !isActive) return false;
    if (timerFilter === 'stopped' && isActive) return false;
    if (!needle) return true;
    const name = timer.name.available ? timer.name.value.toLowerCase() : '';
    const sym = (timer.symbolName || '').toLowerCase();
    return name.includes(needle)
      || sym.includes(needle)
      || matchesHex(timer.address, needle)
      || (timer.callbackAddress.available && matchesHex(timer.callbackAddress.value, needle));
  });
}
