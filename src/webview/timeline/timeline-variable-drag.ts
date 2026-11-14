import { useEffect, useRef, useState, type CSSProperties, type PointerEvent } from 'react';
import type { TimelineEntryState } from './timeline-entry-state';

interface VariableDrag {
  expression: string;
  pointerId: number;
  startY: number;
  clientY: number;
  scrollTop: number;
  sourceIndex: number;
  targetIndex: number;
  heights: number[];
  top: number;
  offset: number;
}

/** 在原列表中预留插入位置，卡片位移只更新本地视图，松开后再提交顺序。 */
export function useTimelineVariableDrag(entries: TimelineEntryState[], onReorder: (expression: string, index: number) => void) {
  const listRef = useRef<HTMLDivElement>(null);
  const sessionRef = useRef<VariableDrag | null>(null);
  const frameRef = useRef<number | null>(null);
  const reorderRef = useRef(onReorder);
  reorderRef.current = onReorder;
  const [drag, setDrag] = useState<VariableDrag | null>(null);

  const finish = (commit: boolean) => {
    const session = sessionRef.current;
    if (!session) return;
    sessionRef.current = null;
    if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
    frameRef.current = null;
    setDrag(null);
    if (listRef.current?.hasPointerCapture(session.pointerId)) listRef.current.releasePointerCapture(session.pointerId);
    if (commit && session.sourceIndex >= 0 && session.targetIndex !== session.sourceIndex) {
      reorderRef.current(session.expression, session.targetIndex);
    }
  };
  const finishRef = useRef(finish);
  finishRef.current = finish;

  useEffect(() => {
    const cancel = () => finishRef.current(false);
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') cancel(); };
    const onVisibilityChange = () => { if (document.hidden) cancel(); };
    window.addEventListener('blur', cancel);
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      window.removeEventListener('blur', cancel);
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
      const session = sessionRef.current;
      sessionRef.current = null;
      if (session && listRef.current?.hasPointerCapture(session.pointerId)) listRef.current.releasePointerCapture(session.pointerId);
    };
  }, []);

  const expressionsRef = useRef(entries.map(entry => entry.expression));
  useEffect(() => {
    const previous = expressionsRef.current;
    if (previous.length !== entries.length || entries.some((entry, index) => entry.expression !== previous[index])) finishRef.current(false);
    expressionsRef.current = entries.map(entry => entry.expression);
  }, [entries]);

  const updatePosition = () => {
    const session = sessionRef.current;
    const list = listRef.current;
    if (!session || !list || session.sourceIndex < 0) return;
    const height = session.heights[session.sourceIndex];
    const maxTop = session.heights.reduce((total, value) => total + value, 0) - height;
    const top = Math.max(0, Math.min(maxTop, session.top + session.clientY - session.startY + list.scrollTop - session.scrollTop));
    let targetIndex = 0;
    let rowTop = 0;
    session.heights.forEach((rowHeight, index) => {
      if (index === session.sourceIndex) return;
      if (top + height / 2 > rowTop + rowHeight / 2) targetIndex++;
      rowTop += rowHeight;
    });
    const offset = top - session.top;
    if (session.offset === offset && session.targetIndex === targetIndex) return;
    session.offset = offset;
    session.targetIndex = targetIndex;
    setDrag({ ...session });
  };

  const animate = () => {
    const session = sessionRef.current;
    const list = listRef.current;
    if (!session || !list) return;
    const rect = list.getBoundingClientRect();
    const edge = Math.min(32, rect.height / 4);
    if (session.clientY < rect.top + edge) list.scrollTop -= Math.min(1, (rect.top + edge - session.clientY) / edge) * 10;
    else if (session.clientY > rect.bottom - edge) list.scrollTop += Math.min(1, (session.clientY - rect.bottom + edge) / edge) * 10;
    updatePosition();
    frameRef.current = requestAnimationFrame(animate);
  };

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || !event.isPrimary || sessionRef.current || entries.length < 2) return false;
    const target = event.target as Element;
    if (target.closest('input, button, select, textarea, a, label, [contenteditable="true"], [role="group"]')) return false;
    const row = target.closest<HTMLElement>('[data-timeline-variable]');
    if (!row || !listRef.current?.contains(row)) return false;
    event.preventDefault();
    sessionRef.current = {
      expression: row.dataset.timelineVariable!, pointerId: event.pointerId,
      startY: event.clientY, clientY: event.clientY, scrollTop: listRef.current.scrollTop,
      sourceIndex: -1, targetIndex: -1, heights: [], top: 0, offset: 0,
    };
    listRef.current.setPointerCapture(event.pointerId);
    return true;
  };

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const session = sessionRef.current;
    const list = listRef.current;
    if (!session || !list || event.pointerId !== session.pointerId) return;
    session.clientY = event.clientY;
    if (session.sourceIndex < 0) {
      if (Math.abs(event.clientY - session.startY) < 4) return;
      const rows = Array.from(list.querySelectorAll<HTMLElement>('[data-timeline-variable]'));
      session.sourceIndex = rows.findIndex(row => row.dataset.timelineVariable === session.expression);
      if (session.sourceIndex < 0) { finish(false); return; }
      session.targetIndex = session.sourceIndex;
      session.heights = rows.map(row => row.offsetHeight);
      session.top = rows[session.sourceIndex].offsetTop;
      session.scrollTop = list.scrollTop;
      setDrag({ ...session });
      frameRef.current = requestAnimationFrame(animate);
    }
    updatePosition();
  };

  const rowStyle = (index: number): CSSProperties => {
    if (!drag) return { cursor: 'grab', touchAction: 'none', userSelect: 'none' };
    const moving = index === drag.sourceIndex;
    let offset = 0;
    if (drag.sourceIndex < index && index <= drag.targetIndex) offset = -drag.heights[drag.sourceIndex];
    if (drag.targetIndex <= index && index < drag.sourceIndex) offset = drag.heights[drag.sourceIndex];
    return {
      cursor: 'grabbing', touchAction: 'none', userSelect: 'none',
      transform: `translateY(${moving ? drag.offset : offset}px)`,
      transition: moving ? 'none' : 'transform 140ms ease',
      zIndex: moving ? 2 : 1,
      background: moving ? 'var(--vscode-editorWidget-background, #252526)' : undefined,
      boxShadow: moving ? '0 4px 12px var(--vscode-widget-shadow, #0008), inset 0 0 0 1px var(--vscode-focusBorder, #007fd4)' : undefined,
    };
  };

  const onPointerUp = (event: PointerEvent<HTMLDivElement>) => {
    if (event.pointerId !== sessionRef.current?.pointerId) return;
    sessionRef.current.clientY = event.clientY;
    updatePosition();
    finish(true);
  };
  const onPointerCancel = (event: PointerEvent<HTMLDivElement>) => {
    if (event.pointerId === sessionRef.current?.pointerId) finish(false);
  };
  return { listRef, rowStyle, onPointerDown, onPointerMove, onPointerUp, onPointerCancel, dragging: drag !== null };
}
