export function formatHex(value: number, width: number = 8): string {
  return `0x${value.toString(16).toUpperCase().padStart(width, '0')}`;
}

export function parseHex(str: string): number {
  return parseInt(str.replace(/^0x/i, ''), 16);
}

export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export function debounce<T extends (...args: any[]) => any>(fn: T, delay: number): T {
  let timer: ReturnType<typeof setTimeout>;
  return ((...args: any[]) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), delay);
  }) as T;
}