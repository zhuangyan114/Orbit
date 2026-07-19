export function extractEditableWatchValue(display: string): string {
  const hex = display.match(/^(0x[0-9A-Fa-f]+)/);
  if (hex) return hex[1];
  const numeric = display.match(/^\(?(-?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)/);
  return numeric ? numeric[1] : display;
}

export function parseWatchValueInput(raw: string): number | null {
  const value = raw.trim();
  if (!value) return null;
  if (/^0x/i.test(value)) {
    if (!/^0x[0-9a-f]+$/i.test(value)) return null;
    return Number.parseInt(value, 16);
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}
