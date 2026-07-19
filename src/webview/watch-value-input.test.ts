import { describe, expect, it } from 'vitest';
import { extractEditableWatchValue, parseWatchValueInput } from './watch-value-input';

describe('Watch value input', () => {
  it('preserves decimal values from Watch displays', () => {
    expect(extractEditableWatchValue('1.500000')).toBe('1.500000');
    expect(extractEditableWatchValue('-0.100000')).toBe('-0.100000');
    expect(extractEditableWatchValue('0x20001000 (536875008)')).toBe('0x20001000');
  });

  it('accepts finite decimal and hexadecimal input without truncating decimals', () => {
    expect(parseWatchValueInput('0.1')).toBe(0.1);
    expect(parseWatchValueInput('1.5')).toBe(1.5);
    expect(parseWatchValueInput('1e-2')).toBe(0.01);
    expect(parseWatchValueInput('0x10')).toBe(16);
    expect(parseWatchValueInput('1.5abc')).toBeNull();
  });
});
