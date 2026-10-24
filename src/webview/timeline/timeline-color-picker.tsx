import React, { useEffect, useRef, useState } from 'react';
import { TIMELINE_COLORS } from './timeline-colors';

interface Hsv { h: number; s: number; v: number; }
const clamp = (value: number, max = 1) => Math.max(0, Math.min(max, value));
const normalizeHex = (color: string) => /^#[0-9a-f]{6}$/i.test(color) ? color.toUpperCase() : '#569CD6';

export function hexToHsv(color: string): Hsv {
  const [r, g, b] = [1, 3, 5].map(offset => parseInt(normalizeHex(color).slice(offset, offset + 2), 16) / 255);
  const v = Math.max(r, g, b), min = Math.min(r, g, b), delta = v - min;
  const sector = delta === 0 ? 0 : v === r ? (g - b) / delta : v === g ? (b - r) / delta + 2 : (r - g) / delta + 4;
  return { h: ((sector * 60) % 360 + 360) % 360, s: v === 0 ? 0 : delta / v, v };
}

export function hsvToHex({ h, s, v }: Hsv): string {
  const hue = ((h % 360) + 360) % 360 / 60;
  const chroma = clamp(v) * clamp(s), x = chroma * (1 - Math.abs(hue % 2 - 1)), m = clamp(v) - chroma;
  const channels = hue < 1 ? [chroma, x, 0] : hue < 2 ? [x, chroma, 0]
    : hue < 3 ? [0, chroma, x] : hue < 4 ? [0, x, chroma] : hue < 5 ? [x, 0, chroma] : [chroma, 0, x];
  return '#' + channels.map(channel => Math.round((channel + m) * 255).toString(16).padStart(2, '0')).join('').toUpperCase();
}

/** Keep the complete picker in the webview: native color popups cannot inherit VS Code theme tokens. */
export function TimelineColorPicker({ expression, color, onChange, onClose }: {
  expression: string;
  color: string;
  onChange: (color: string) => void;
  onClose: () => void;
}) {
  const [hsv, setHsv] = useState(() => hexToHsv(color));
  const [hexInput, setHexInput] = useState(() => normalizeHex(color));
  const hsvRef = useRef(hsv);
  const lastEmitted = useRef(normalizeHex(color));
  const activePointer = useRef<number | null>(null);
  useEffect(() => {
    const normalized = normalizeHex(color);
    // Preserve the selected hue at black/gray and the exact pointer position on our own color echoes.
    if (normalized !== lastEmitted.current) {
      hsvRef.current = hexToHsv(normalized);
      setHsv(hsvRef.current);
      lastEmitted.current = normalized;
    }
    setHexInput(normalized);
  }, [color]);

  const applyHsv = (next: Hsv) => {
    hsvRef.current = next;
    setHsv(next);
    const hex = hsvToHex(next);
    lastEmitted.current = hex;
    setHexInput(hex);
    onChange(hex);
  };
  const applyHex = (hex: string) => applyHsv(hexToHsv(hex));
  const updatePlane = (event: React.PointerEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    if (rect.width && rect.height) applyHsv({
      ...hsvRef.current,
      s: clamp((event.clientX - rect.left) / rect.width),
      v: 1 - clamp((event.clientY - rect.top) / rect.height),
    });
  };
  const finishPointer = (event: React.PointerEvent<HTMLDivElement>) => {
    if (activePointer.current !== event.pointerId) return;
    activePointer.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };
  const hex = hsvToHex(hsv);
  const rgb = [1, 3, 5].map(offset => parseInt(hex.slice(offset, offset + 2), 16));
  return <>
    <style>{`
      .timeline-color-hue::-webkit-slider-thumb {
        -webkit-appearance: none; appearance: none; width: 12px; height: 18px; border-radius: 4px;
        border: 2px solid var(--vscode-editorWidget-foreground, var(--vscode-foreground, #ccc));
        background: var(--vscode-editorWidget-background, #252526); box-shadow: 0 0 2px #000;
      }
      .timeline-color-hue::-moz-range-thumb {
        width: 8px; height: 14px; border-radius: 4px;
        border: 2px solid var(--vscode-editorWidget-foreground, var(--vscode-foreground, #ccc));
        background: var(--vscode-editorWidget-background, #252526);
      }
    `}</style>
    <div role="slider" tabIndex={0} aria-label={`${expression} 饱和度和明度`}
      aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(hsv.s * 100)}
      aria-valuetext={`饱和度 ${Math.round(hsv.s * 100)}%，明度 ${Math.round(hsv.v * 100)}%`}
      onPointerDown={event => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.currentTarget.focus();
        activePointer.current = event.pointerId;
        event.currentTarget.setPointerCapture(event.pointerId);
        updatePlane(event);
      }}
      onPointerMove={event => { if (activePointer.current === event.pointerId) updatePlane(event); }}
      onPointerUp={finishPointer} onPointerCancel={finishPointer}
      onLostPointerCapture={() => { activePointer.current = null; }}
      onKeyDown={event => {
        const step = event.shiftKey ? 0.1 : 0.01;
        const delta = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] }[event.key];
        if (!delta) return;
        event.preventDefault();
        applyHsv({ ...hsvRef.current, s: clamp(hsvRef.current.s + delta[0]), v: clamp(hsvRef.current.v + delta[1]) });
      }}
      style={{ height: 116, position: 'relative', cursor: 'crosshair', touchAction: 'none', borderRadius: 2,
        background: `linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, transparent), ${hsvToHex({ h: hsv.h, s: 1, v: 1 })}` }}>
      <span style={{ position: 'absolute', left: `${hsv.s * 100}%`, top: `${(1 - hsv.v) * 100}%`,
        width: 9, height: 9, boxSizing: 'border-box', border: '2px solid #fff', borderRadius: '50%',
        boxShadow: '0 0 0 1px #333', transform: 'translate(-50%, -50%)', pointerEvents: 'none' }} />
    </div>
    <input type="range" className="timeline-color-hue" aria-label={`${expression} 色相`}
      min={0} max={360} step={1} value={hsv.h}
      onChange={event => applyHsv({ ...hsvRef.current, h: Number(event.target.value) })}
      style={{ width: '100%', margin: '10px 0', height: 12, appearance: 'none', borderRadius: 3, cursor: 'pointer',
        background: 'linear-gradient(to right, #f00, #ff0, #0f0, #0ff, #00f, #f0f, #f00)' }} />
    <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginBottom: 6 }}>
      <span aria-hidden="true" style={{ width: 20, height: 20, flexShrink: 0, background: hex,
        border: '1px solid var(--vscode-widget-border, #888)', borderRadius: 3 }} />
      <input type="text" aria-label={`${expression} 自定义颜色`} value={hexInput} maxLength={7}
        spellCheck={false} placeholder="#RRGGBB"
        onChange={event => {
          const value = event.target.value;
          setHexInput(value);
          if (/^#[0-9a-f]{6}$/i.test(value)) applyHex(value);
        }}
        onBlur={() => setHexInput(hex)}
        onKeyDown={event => { if (event.key === 'Enter') setHexInput(hex); }}
        style={{ ...colorInputStyle, flex: 1, width: 0, fontFamily: 'monospace', fontSize: 10 }} />
      <button type="button" aria-label="关闭颜色选择" onClick={onClose} style={{
        background: 'var(--vscode-button-secondaryBackground, #3a3d41)', color: 'inherit',
        border: '1px solid var(--vscode-widget-border, #555)', borderRadius: 3, cursor: 'pointer', padding: '2px 5px',
      }}>×</button>
    </div>
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 5, marginBottom: 8 }}>
      {['R', 'G', 'B'].map((channel, index) => <label key={channel} style={{ textAlign: 'center', fontSize: 10 }}>
        <input type="number" min={0} max={255} step={1} aria-label={`${expression} ${channel}`} value={rgb[index]}
          onChange={event => {
            const value = event.target.valueAsNumber;
            if (!Number.isInteger(value) || value < 0 || value > 255) return;
            const channels = [...rgb]; channels[index] = value;
            applyHex('#' + channels.map(part => part.toString(16).padStart(2, '0')).join(''));
          }}
          style={{ ...colorInputStyle, width: '100%', fontSize: 11, marginBottom: 2 }} />
        {channel}
      </label>)}
    </div>
    <div aria-label="常用颜色" style={{ display: 'grid', gridTemplateColumns: 'repeat(6, minmax(0, 1fr))', gap: 5 }}>
      {TIMELINE_COLORS.map(preset => <button key={preset} type="button" title={preset}
        aria-label={`使用颜色 ${preset}`} aria-pressed={hex === preset} onClick={() => applyHex(preset)}
        style={{ height: 18, minWidth: 0, padding: 0, borderRadius: 3, background: preset, cursor: 'pointer',
          border: hex === preset ? '2px solid var(--vscode-focusBorder, #fff)' : '1px solid rgba(128,128,128,0.5)' }} />)}
    </div>
  </>;
}

const colorInputStyle: React.CSSProperties = {
  boxSizing: 'border-box', minWidth: 0, padding: '3px 2px', borderRadius: 2,
  border: '1px solid var(--vscode-input-border, var(--vscode-widget-border, #555))',
  background: 'var(--vscode-input-background, #3c3c3c)', color: 'var(--vscode-input-foreground, #ccc)',
};
