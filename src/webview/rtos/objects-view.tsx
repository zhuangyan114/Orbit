import React, { useMemo } from 'react';
import type { HeapBlockLifecycleStatus, ObjectLifecycleStatus, ObjectsDiscoverySummary, SyncObjectSnapshot, WaitEdge } from '../../rtos/model';
import {
  filterSyncObjects,
  formatFieldValue,
  formatHex32,
  objectKindLabel,
  RtosObjectKindFilter,
  RtosViewSettings,
} from './rtos-view-state';

const KIND_FILTERS: { id: RtosObjectKindFilter; label: string }[] = [
  { id: 'all', label: '全部' },
  { id: 'queue', label: 'Queue' },
  { id: 'mutex', label: 'Mutex / 递归锁' },
  { id: 'semaphore', label: 'Semaphore' },
  { id: 'issues', label: '异常 / 删除中' },
];

const SOURCE_LABELS: Record<string, string> = {
  registry: 'Registry',
  global: 'Global',
  list: 'WaitList',
};

const CONFIDENCE_LABELS: Record<string, string> = {
  'halted-verified': '暂停态已校验',
  'live-best-effort': '运行态尽力采集',
  'partial-unverified': '部分/未双端校验',
};

const LIFECYCLE_LABELS: Record<ObjectLifecycleStatus, string> = {
  'confirmed-static': '已确认静态分配',
  'confirmed-freed': '已确认释放',
  unconfirmed: '身份未确认',
};

const HEAP_BLOCK_LABELS: Record<HeapBlockLifecycleStatus, string> = {
  allocated: '块当前已分配',
  freed: '块已释放',
  'corrupt-header': '块头异常',
  static: '静态存储',
  unverified: '未校验',
};

export function ObjectsView({
  summary,
  settings,
  canInspect,
  refreshing,
  onUpdateSettings,
  onInspectObject,
  onSelectTask,
}: {
  summary: ObjectsDiscoverySummary | undefined;
  settings: RtosViewSettings;
  canInspect: boolean;
  refreshing: boolean;
  onUpdateSettings: (patch: Partial<RtosViewSettings>) => void;
  onInspectObject: (address?: number) => void;
  onSelectTask: (taskAddress: number) => void;
}) {
  const objects = summary?.objects ?? [];
  const filtered = useMemo(
    () => filterSyncObjects(objects, settings.objectKindFilter, settings.objectSearchQuery),
    [objects, settings.objectKindFilter, settings.objectSearchQuery],
  );
  const selected = useMemo(
    () => (settings.selectedObjectAddress !== null ? objects.find(o => o.address === settings.selectedObjectAddress) ?? null : null),
    [objects, settings.selectedObjectAddress],
  );

  if (!summary) {
    return (
      <div className="rtos-empty" role="status">
        <h3>尚未获取队列与锁对象快照</h3>
        <p>点击下方按钮读取可发现的 Queue、Mutex、Semaphore 与等待关系。</p>
        <button type="button" className="rtos-btn" disabled={!canInspect || refreshing} onClick={() => onInspectObject()}>
          {refreshing ? '正在读取…' : '读取队列与锁'}
        </button>
      </div>
    );
  }

  const selectedEdges: WaitEdge[] = selected
    ? summary.waitEdges.filter(edge => edge.objectAddress === selected.address)
    : [];

  return (
    <div className="rtos-workspace">
      <div className="rtos-table-pane">
        <div className="rtos-coverage-bar">
          <span>{summary.coverageNote}</span>
          <span className="rtos-mono">
            Registry {summary.registryCount}{summary.registryCapacity ? `/${summary.registryCapacity}` : ''} · Global {summary.globalCount} · WaitList {summary.listDiscoveredCount}
          </span>
        </div>

        {summary.waitCycles.length > 0 && (
          <div className="rtos-cycle-banner" role="alert">
            {summary.waitCycles.map((cycle, idx) => (
              <div key={idx} className="rtos-cycle-item">
                <strong>
                  ⚠ 候选等待环（{CONFIDENCE_LABELS[cycle.confidence] || cycle.confidence}）：
                </strong>
                <span className="rtos-mono">
                  {cycle.tasks.map(t => `${t.name || formatHex32(t.address)} → [${t.objectName || formatHex32(t.waitingOnObject)}]`).join(' → ')} → {cycle.tasks[0]?.name || formatHex32(cycle.tasks[0]?.address || 0)}
                </span>
                <div className="rtos-muted">{cycle.note}</div>
              </div>
            ))}
          </div>
        )}

        {summary.unresolvedWaits.length > 0 && (
          <div className="rtos-unresolved-bar">
            {summary.unresolvedWaits.map(item => (
              <div key={item.listAddress}>
                未解析等待列表 <span className="rtos-mono">{formatHex32(item.listAddress)}</span>（等待任务 {item.waitingTaskAddresses.map(formatHex32).join(', ')}）：{item.reason}
              </div>
            ))}
          </div>
        )}

        <div className="rtos-filter-bar">
          <input
            type="search"
            aria-label="筛选对象"
            className="rtos-search"
            placeholder="搜索对象名、符号、地址或持有者…"
            value={settings.objectSearchQuery}
            onChange={event => onUpdateSettings({ objectSearchQuery: event.target.value })}
          />
          <div className="rtos-filter-chips" role="group" aria-label="按对象类型筛选">
            {KIND_FILTERS.map(opt => (
              <button
                key={opt.id}
                type="button"
                className={`rtos-chip${settings.objectKindFilter === opt.id ? ' active' : ''}`}
                onClick={() => onUpdateSettings({ objectKindFilter: opt.id })}
              >
                {opt.label}
              </button>
            ))}
          </div>
          <button
            type="button"
            className="rtos-mini-btn"
            disabled={!canInspect || refreshing}
            onClick={() => onInspectObject()}
          >
            {refreshing ? '读取中…' : '刷新全部详情'}
          </button>
          <span className="rtos-count">{filtered.length} / {objects.length} 对象</span>
        </div>

        <div className="rtos-table-scroll">
          <table className="rtos-table">
            <thead>
              <tr>
                <th>类型</th>
                <th>名称 / 符号</th>
                <th>地址</th>
                <th>发现来源</th>
                <th>计数 / 容量</th>
                <th>持有者 / 递归</th>
                <th>等待任务</th>
                <th>状态 / 说明</th>
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0 ? (
                <tr>
                  <td colSpan={8} className="rtos-table-empty">
                    {objects.length === 0 ? '未发现已注册、全局或等待中的队列/锁对象' : '没有符合筛选条件的对象'}
                  </td>
                </tr>
              ) : filtered.map(obj => {
                const isSelected = settings.selectedObjectAddress === obj.address;
                const recvWait = obj.waitingToReceiveCount.available ? obj.waitingToReceiveCount.value : 0;
                const sendWait = obj.waitingToSendCount.available ? obj.waitingToSendCount.value : 0;
                const displayName = obj.name.available ? obj.name.value : (obj.symbolName || '(未注册无名)');
                return (
                  <tr
                    key={obj.address}
                    className={`rtos-row${isSelected ? ' selected' : ''}`}
                    tabIndex={0}
                    aria-selected={isSelected}
                    onClick={() => onUpdateSettings({ selectedObjectAddress: isSelected ? null : obj.address })}
                    onKeyDown={event => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault();
                        onUpdateSettings({ selectedObjectAddress: isSelected ? null : obj.address });
                      }
                    }}
                  >
                    <td>
                      <span className="rtos-state-badge" title={obj.kindSource}>
                        {objectKindLabel(obj.kind)}{obj.kindUncertain ? ' ?' : ''}
                      </span>
                    </td>
                    <td>
                      <div className="rtos-task-name">
                        <span title={obj.name.available ? obj.name.source : obj.name.reason}>{displayName}</span>
                        {obj.name.available && obj.symbolName && obj.symbolName !== obj.name.value && (
                          <span className="rtos-task-id">({obj.symbolName})</span>
                        )}
                      </div>
                    </td>
                    <td className="rtos-mono">{formatHex32(obj.address)}</td>
                    <td>
                      <div className="rtos-source-chips" title={obj.discoveryNote}>
                        {obj.discoverySources.map(src => (
                          <span key={src} className="rtos-evidence">{SOURCE_LABELS[src] || src}</span>
                        ))}
                      </div>
                    </td>
                    <td className="rtos-mono">
                      {obj.messagesWaiting.available && obj.length.available
                        ? `${obj.messagesWaiting.value} / ${obj.length.value}${obj.itemSize.available && obj.itemSize.value > 0 ? ` (${obj.itemSize.value}B)` : ''}`
                        : '—'}
                    </td>
                    <td>
                      {obj.holder ? (
                        <div className="rtos-cpu-cell" title={obj.holder.evidence}>
                          {obj.holder.address !== null ? (
                            <span className="rtos-mono">
                              {obj.holder.taskName || formatHex32(obj.holder.address)}
                              {obj.kind === 'recursive-mutex' && obj.holder.recursiveCallCount.available ? ` ×${obj.holder.recursiveCallCount.value}` : ''}
                            </span>
                          ) : (
                            <span className="rtos-muted">空闲</span>
                          )}
                          <span className="rtos-evidence">{CONFIDENCE_LABELS[obj.holder.confidence]}</span>
                        </div>
                      ) : (
                        <span className="rtos-muted" title="仅互斥锁与递归锁具有持有者">—</span>
                      )}
                    </td>
                    <td>
                      <div className="rtos-list-cell">
                        <span className="rtos-mono">收:{recvWait} 发:{sendWait}</span>
                        {obj.waitListEvidence === 'summary-only' && (recvWait > 0 || sendWait > 0) && (
                          <button
                            type="button"
                            className="rtos-mini-btn"
                            disabled={!canInspect || refreshing}
                            onClick={event => {
                              event.stopPropagation();
                              onInspectObject(obj.address);
                            }}
                          >
                            详情
                          </button>
                        )}
                      </div>
                    </td>
                    <td>
                      {obj.health === 'valid' ? (
                        obj.lifecycle === 'confirmed-static' ? (
                          <span className="rtos-muted" title={obj.healthReason || obj.lifecycleReason || '静态对象校验正常'}>
                            {obj.healthReason ? `提示: ${obj.healthReason}` : '正常'}
                          </span>
                        ) : obj.heapBlock === 'allocated' ? (
                          <span className="rtos-inline-warn" title={obj.lifecycleReason || obj.heapBlockReason || '堆块当前已分配，但对象身份未确认'}>
                            未确认（块已分配）{obj.healthReason ? ` · ${obj.healthReason}` : ''}
                          </span>
                        ) : (
                          <span className="rtos-inline-warn" title={obj.lifecycleReason || obj.healthReason || '仅完成结构校验，生命周期未确认'}>
                            {obj.healthReason ? `生命周期未确认 (${obj.healthReason})` : '生命周期未确认'}
                          </span>
                        )
                      ) : (
                        <span className="rtos-inline-warn" title={obj.healthReason || obj.lifecycleReason}>
                          {obj.lifecycle === 'confirmed-freed'
                            ? '已释放'
                            : obj.health === 'deleting-or-corrupt'
                              ? '删除中/异常'
                              : '不完整'}: {obj.healthReason || obj.lifecycleReason || '结构异常'}
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {selected && (
        <ObjectDetailPane
          obj={selected}
          edges={selectedEdges}
          canInspect={canInspect}
          refreshing={refreshing}
          onClose={() => onUpdateSettings({ selectedObjectAddress: null })}
          onInspect={() => onInspectObject(selected.address)}
          onSelectTask={onSelectTask}
        />
      )}
    </div>
  );
}

function ObjectDetailPane({
  obj,
  edges,
  canInspect,
  refreshing,
  onClose,
  onInspect,
  onSelectTask,
}: {
  obj: SyncObjectSnapshot;
  edges: WaitEdge[];
  canInspect: boolean;
  refreshing: boolean;
  onClose: () => void;
  onInspect: () => void;
  onSelectTask: (taskAddress: number) => void;
}) {
  return (
    <aside className="rtos-detail-pane" aria-label="对象详情">
      <div className="rtos-detail-header">
        <strong>{obj.name.available ? obj.name.value : (obj.symbolName || formatHex32(obj.address))}</strong>
        <button type="button" className="rtos-mini-btn" onClick={onClose}>关闭</button>
      </div>
      <div className="rtos-detail-grid">
        <div className="rtos-detail-item">
          <span className="rtos-detail-label">地址 / 类型</span>
          <span className="rtos-detail-value rtos-mono">{formatHex32(obj.address)} · {objectKindLabel(obj.kind)}</span>
        </div>
        <div className="rtos-detail-item">
          <span className="rtos-detail-label">类型依据</span>
          <span className="rtos-detail-value">{obj.kindSource}</span>
        </div>
        <div className="rtos-detail-item">
          <span className="rtos-detail-label">发现方式</span>
          <span className="rtos-detail-value">{obj.discoveryNote}</span>
        </div>
        <div className="rtos-detail-item">
          <span className="rtos-detail-label">健康状态</span>
          <span className="rtos-detail-value">{obj.health}{obj.healthReason ? ` — ${obj.healthReason}` : ''}</span>
        </div>
        {obj.heapBlock && (
          <div className="rtos-detail-item">
            <span className="rtos-detail-label">堆块状态</span>
            <span className="rtos-detail-value">
              {HEAP_BLOCK_LABELS[obj.heapBlock]} ({obj.heapBlock})
              {obj.heapBlockReason ? ` — ${obj.heapBlockReason}` : ''}
            </span>
          </div>
        )}
        <div className="rtos-detail-item">
          <span className="rtos-detail-label">生命周期验证</span>
          <span className="rtos-detail-value">
            {obj.lifecycle ? `${LIFECYCLE_LABELS[obj.lifecycle]} (${obj.lifecycle})` : LIFECYCLE_LABELS.unconfirmed}
            {obj.lifecycleReason ? ` — ${obj.lifecycleReason}` : ''}
          </span>
        </div>
        <div className="rtos-detail-item">
          <span className="rtos-detail-label">锁定与分配</span>
          <span className="rtos-detail-value rtos-mono">
            cRxLock={formatFieldValue(obj.rxLock)} · cTxLock={formatFieldValue(obj.txLock)} · 静态={formatFieldValue(obj.staticallyAllocated, v => v ? '是' : '否')} · 编号={formatFieldValue(obj.queueNumber)}
          </span>
        </div>
        {obj.holder && (
          <div className="rtos-detail-item">
            <span className="rtos-detail-label">互斥锁持有者</span>
            <span className="rtos-detail-value">
              {obj.holder.address !== null ? (
                <button type="button" className="rtos-link-btn" onClick={() => onSelectTask(obj.holder!.address!)}>
                  {obj.holder.taskName || formatHex32(obj.holder.address)}
                </button>
              ) : '空闲'}
              {' '}({CONFIDENCE_LABELS[obj.holder.confidence]} · 递归={formatFieldValue(obj.holder.recursiveCallCount)})
              <div className="rtos-muted">{obj.holder.evidence}</div>
            </span>
          </div>
        )}
        <div className="rtos-detail-item">
          <span className="rtos-detail-label">等待接收 / 获取任务 ({formatFieldValue(obj.waitingToReceiveCount)})</span>
          <span className="rtos-detail-value">
            {obj.waitingToReceive?.length ? obj.waitingToReceive.map(w => (
              <div key={w.taskAddress} className="rtos-waiter-row">
                <button type="button" className="rtos-link-btn" onClick={() => onSelectTask(w.taskAddress)}>
                  {w.taskName || formatHex32(w.taskAddress)}
                </button>
                <span className="rtos-evidence">{w.taskListVerified ? 'TCB互验' : '仅列表'}</span>
              </div>
            )) : (obj.waitListEvidence === 'summary-only' ? '未遍历（点击下方按钮按需加载）' : '无')}
          </span>
        </div>
        <div className="rtos-detail-item">
          <span className="rtos-detail-label">等待发送任务 ({formatFieldValue(obj.waitingToSendCount)})</span>
          <span className="rtos-detail-value">
            {obj.waitingToSend?.length ? obj.waitingToSend.map(w => (
              <div key={w.taskAddress} className="rtos-waiter-row">
                <button type="button" className="rtos-link-btn" onClick={() => onSelectTask(w.taskAddress)}>
                  {w.taskName || formatHex32(w.taskAddress)}
                </button>
                <span className="rtos-evidence">{w.taskListVerified ? 'TCB互验' : '仅列表'}</span>
              </div>
            )) : (obj.waitListEvidence === 'summary-only' ? '未遍历（点击下方按钮按需加载）' : '无')}
          </span>
        </div>
        {edges.length > 0 && (
          <div className="rtos-detail-item">
            <span className="rtos-detail-label">等待边证据</span>
            <span className="rtos-detail-value">
              {edges.map((e, i) => (
                <div key={i}>{e.taskName || formatHex32(e.taskAddress)} ({e.direction}) · {CONFIDENCE_LABELS[e.confidence]} · {e.evidence}</div>
              ))}
            </span>
          </div>
        )}
      </div>
      <button type="button" className="rtos-btn" disabled={!canInspect || refreshing} onClick={onInspect}>
        {refreshing ? '正在读取详情…' : '按需刷新该对象等待链'}
      </button>
    </aside>
  );
}
