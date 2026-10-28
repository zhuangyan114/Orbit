export interface TimelineHoverValue { label: string; value: string; color: string; }

/** Interaction overlay, independent of React commits and waveform rasterization. */
export class TimelineHoverLayer {
  private readonly crosshair: HTMLDivElement;
  private readonly tooltip: HTMLDivElement;
  private rows: { label: string; node: HTMLDivElement; name: HTMLSpanElement; value: HTMLSpanElement }[] = [];
  private observer: ResizeObserver;
  private width = 0;
  private position: { x: number; y: number; canvasWidth: number } | null = null;

  constructor(private host: HTMLDivElement) {
    const doc = host.ownerDocument;
    this.crosshair = doc.createElement('div');
    Object.assign(this.crosshair.style, { position: 'absolute', top: '8px', bottom: '28px', left: '0',
      borderLeft: '1px dashed var(--vscode-foreground)', pointerEvents: 'none', display: 'none' });
    this.tooltip = doc.createElement('div');
    this.tooltip.dataset.timelineHover = 'true';
    Object.assign(this.tooltip.style, { position: 'absolute', left: '0', top: '0', background: 'var(--vscode-editorHoverWidget-background, var(--vscode-editor-background))',
      border: '1px solid var(--vscode-editorHoverWidget-border, var(--vscode-sideBar-border, #555))', borderRadius: '4px', padding: '4px 8px', fontSize: '11px',
      pointerEvents: 'none', whiteSpace: 'nowrap', zIndex: '10', boxShadow: '0 2px 8px rgba(0,0,0,0.4)', display: 'none' });
    host.append(this.crosshair, this.tooltip);
    this.observer = new ResizeObserver(entries => {
      const border = entries[0]?.borderBoxSize?.[0];
      this.width = border?.inlineSize ?? this.tooltip.getBoundingClientRect().width;
      this.placeTooltip();
    });
    this.observer.observe(this.tooltip);
  }

  update(x: number, y: number, canvasWidth: number, values: TimelineHoverValue[]) {
    this.position = { x, y, canvasWidth };
    this.crosshair.style.display = 'block';
    this.crosshair.style.transform = `translate3d(${x}px,0,0)`;
    const doc = this.host.ownerDocument;
    if (values.length !== this.rows.length || values.some((v, i) => v.label !== this.rows[i].label)) {
      this.rows = values.map(v => {
        const node = doc.createElement('div'), name = doc.createElement('span'), value = doc.createElement('span');
        Object.assign(node.style, { display: 'flex', alignItems: 'center', gap: '6px' });
        name.style.fontWeight = 'bold'; name.textContent = v.label;
        Object.assign(value.style, { color: 'var(--vscode-editorHoverWidget-foreground, var(--vscode-foreground))', fontFamily: 'monospace' });
        node.append(name, value); return { label: v.label, node, name, value };
      });
      this.tooltip.replaceChildren(...this.rows.map(row => row.node));
    }
    values.forEach((v, i) => {
      const row = this.rows[i];
      if (row.value.textContent !== v.value) row.value.textContent = v.value;
      row.name.style.color = v.color;
    });
    this.tooltip.style.display = values.length ? 'block' : 'none';
    this.placeTooltip();
  }

  private placeTooltip() {
    if (!this.position) return;
    const { x, y, canvasWidth } = this.position;
    const left = x + 14 + this.width > canvasWidth ? Math.max(0, x - 14 - this.width) : x + 14;
    this.tooltip.style.transform = `translate3d(${left}px,${y - 8}px,0)`;
  }

  hide() { this.position = null; this.crosshair.style.display = 'none'; this.tooltip.style.display = 'none'; }
  dispose() { this.observer.disconnect(); this.crosshair.remove(); this.tooltip.remove(); }
}
