import React, { useMemo } from 'react';
import type { HeapOverview, TimersDiscoverySummary } from '../../rtos/model';
import {
  filterTimers,
  formatFieldValue,
  formatHex32,
  RtosTimerFilter,
  RtosViewSettings,
  timerStateLabel,
} from './rtos-view-state';

const TIMER_FILTERS: { id: RtosTimerFilter; label: string }[] = [
  { id: 'all', label: '全部' },
  { id: 'active', label: '活动' },
  { id: 'stopped', label: '已停止' },
];

export function TimersHeapView({
  timers,
  heap,
  settings,
  canRefresh,
  refreshing,
  onUpdateSettings,
  onRefreshTimersHeap,
}: {
  timers: TimersDiscoverySummary | undefined;
  heap: HeapOverview | undefined;
  settings: RtosViewSettings;
  canRefresh: boolean;
  refreshing: boolean;
  onUpdateSettings: (patch: Partial<RtosViewSettings>) => void;
  onRefreshTimersHeap: () => void;
}) {
  const timerRows = timers?.timers ?? [];
  const filteredTimers = useMemo(
    () => filterTimers(timerRows, settings.timerFilter, settings.timerSearchQuery),
    [timerRows, settings.timerFilter, settings.timerSearchQuery],
  );

  const usable = heap?.usableBytes.available ? heap.usableBytes.value : undefined;
  const used = heap?.usedBytes.available ? heap.usedBytes.value : undefined;
  const usageRatio = usable && used !== undefined && usable > 0 ? Math.min(1, used / usable) : undefined;

  return (
    <div className="rtos-subview-shell">
      {/* Heap 概览区 */}
      <section className="rtos-heap-card" aria-label="Heap 概览">
        <div className="rtos-heap-header">
          <div className="rtos-toolbar-group">
            <strong>Heap 概览</strong>
            {heap && (
              <span className={`rtos-pill ${heap.supported ? (heap.initialized ? 'rtos-tone-ok' : 'rtos-tone-info') : 'rtos-tone-warn'}`}>
                {heap.allocator}{heap.supported ? (heap.initialized ? ' · 已初始化' : ' · 未初始化') : ' · 不支持/不可用'}
              </span>
            )}
          </div>
          <button
            type="button"
            className="rtos-mini-btn"
            disabled={!canRefresh || refreshing}
            onClick={onRefreshTimersHeap}
          >
            {refreshing ? '读取中…' : '刷新定时器与堆'}
          </button>
        </div>

        {!heap ? (
          <div className="rtos-muted">尚未读取堆快照，点击“刷新定时器与堆”或顶部“刷新”。</div>
        ) : !heap.supported ? (
          <div className="rtos-muted">{heap.unavailableReason || heap.note}</div>
        ) : (
          <>
            <div className="rtos-heap-metrics">
              <HeapStat
                label="已用 / 可用容量"
                value={used !== undefined && usable !== undefined ? `${used} / ${usable} B (${(used / usable * 100).toFixed(1)}%)` : '—'}
                title={heap.usedBytes.available ? heap.usedBytes.source : heap.usedBytes.reason}
              />
              <HeapStat
                label="配置总缓冲 (ucHeap)"
                value={formatFieldValue(heap.configuredBytes, v => `${v} B`)}
                title={heap.configuredBytes.source}
              />
              <HeapStat
                label="当前剩余 (xFreeBytesRemaining)"
                value={formatFieldValue(heap.freeBytes, v => `${v} B`)}
                title={heap.freeBytes.available ? heap.freeBytes.source : heap.freeBytes.reason}
              />
              <HeapStat
                label="历史最低剩余"
                value={formatFieldValue(heap.minimumEverFreeBytes, v => `${v} B`)}
                title={heap.minimumEverFreeBytes.available ? heap.minimumEverFreeBytes.source : heap.minimumEverFreeBytes.reason}
              />
              <HeapStat
                label="成功分配 / 释放"
                value={`${formatFieldValue(heap.successfulAllocations)} / ${formatFieldValue(heap.successfulFrees)}`}
                title="heap_4.xNumberOfSuccessfulAllocations / Frees"
              />
            </div>
            {usageRatio !== undefined && (
              <div className="rtos-heap-bar-wrap">
                <span className="rtos-bar rtos-heap-bar" aria-hidden="true">
                  <span className={`rtos-bar-fill${usageRatio > 0.85 ? ' warn' : ''}`} style={{ width: `${Math.round(usageRatio * 100)}%` }} />
                </span>
              </div>
            )}
            <div className="rtos-muted">{heap.note}</div>
          </>
        )}
      </section>

      {/* Software Timers 表格区 */}
      <div className="rtos-table-pane">
        <div className="rtos-coverage-bar">
          <span>{timers ? timers.coverageNote : '尚未读取 Software Timers 快照。'}</span>
          {timers && (
            <span className="rtos-mono">
              {timers.tickCount?.available ? `Tick=${timers.tickCount.value} · ` : ''}
              当前 {timers.activeCurrentCount} · 溢出 {timers.activeOverflowCount} · 全局已停 {timers.globalStoppedCount}
            </span>
          )}
        </div>

        <div className="rtos-filter-bar">
          <input
            type="search"
            aria-label="筛选定时器"
            className="rtos-search"
            placeholder="搜索定时器名、符号、地址或回调…"
            value={settings.timerSearchQuery}
            onChange={event => onUpdateSettings({ timerSearchQuery: event.target.value })}
          />
          <div className="rtos-filter-chips" role="group" aria-label="按定时器状态筛选">
            {TIMER_FILTERS.map(opt => (
              <button
                key={opt.id}
                type="button"
                className={`rtos-chip${settings.timerFilter === opt.id ? ' active' : ''}`}
                onClick={() => onUpdateSettings({ timerFilter: opt.id })}
              >
                {opt.label}
              </button>
            ))}
          </div>
          <span className="rtos-count">{filteredTimers.length} / {timerRows.length} 定时器</span>
        </div>

        <div className="rtos-table-scroll">
          {timers && !timers.enabled ? (
            <div className="rtos-empty" role="status">
              <h3>Software Timers 未启用</h3>
              <p>{timers.unavailableReason || 'configUSE_TIMERS 未开启或缺少 timers.c DWARF 符号。'}</p>
            </div>
          ) : (
            <table className="rtos-table">
              <thead>
                <tr>
                  <th>状态</th>
                  <th>定时器名 / 符号</th>
                  <th>地址</th>
                  <th>发现来源</th>
                  <th>模式 / 分配</th>
                  <th>周期 (ticks)</th>
                  <th>下次到期 tick</th>
                  <th>回调 / TimerID</th>
                  <th>说明</th>
                </tr>
              </thead>
              <tbody>
                {filteredTimers.length === 0 ? (
                  <tr>
                    <td colSpan={9} className="rtos-table-empty">
                      {!timers
                        ? '尚未采集定时器快照，点击上方“刷新定时器与堆”读取'
                        : timerRows.length === 0
                          ? '未发现活动或全局引用的 Software Timer'
                          : '没有符合筛选条件的定时器'}
                    </td>
                  </tr>
                ) : filteredTimers.map(timer => {
                  const displayName = timer.name.available ? timer.name.value : (timer.symbolName || '(无名定时器)');
                  const modeText = timer.autoReload.available ? (timer.autoReload.value ? 'AutoReload' : 'OneShot') : '—';
                  const allocText = timer.staticallyAllocated.available ? (timer.staticallyAllocated.value ? '静态' : '动态') : '—';
                  return (
                    <tr key={timer.address} className="rtos-row">
                      <td>
                        <span className={`rtos-state-badge ${timer.listState.startsWith('active') ? 'rtos-state-running' : 'rtos-state-suspended'}`}>
                          {timerStateLabel(timer.listState)}
                        </span>
                      </td>
                      <td>
                        <div className="rtos-task-name">
                          <span title={timer.name.available ? timer.name.source : timer.name.reason}>{displayName}</span>
                          {timer.name.available && timer.symbolName && timer.symbolName !== timer.name.value && (
                            <span className="rtos-task-id">({timer.symbolName})</span>
                          )}
                        </div>
                      </td>
                      <td className="rtos-mono">{formatHex32(timer.address)}</td>
                      <td>
                        <div className="rtos-source-chips">
                          {timer.discoverySources.map(src => (
                            <span key={src} className="rtos-evidence">{src === 'list' ? 'ActiveList' : 'Global'}</span>
                          ))}
                        </div>
                      </td>
                      <td>{modeText} · {allocText}</td>
                      <td className="rtos-mono">{formatFieldValue(timer.periodTicks)}</td>
                      <td className="rtos-mono" title={timer.expiryTick.available ? timer.expiryTick.source : timer.expiryTick.reason}>
                        {formatFieldValue(timer.expiryTick)}
                      </td>
                      <td className="rtos-mono">
                        {formatFieldValue(timer.callbackAddress, formatHex32)} · ID={formatFieldValue(timer.timerId, formatHex32)}
                      </td>
                      <td>
                        {timer.health === 'valid' ? (
                          <span className="rtos-muted">正常</span>
                        ) : (
                          <span className="rtos-inline-warn" title={timer.healthReason}>
                            {timer.healthReason || timer.health}
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}

function HeapStat({ label, value, title }: { label: string; value: string; title?: string }) {
  return (
    <div className="rtos-heap-stat" title={title}>
      <span className="rtos-detail-label">{label}</span>
      <span className="rtos-mono">{value}</span>
    </div>
  );
}
