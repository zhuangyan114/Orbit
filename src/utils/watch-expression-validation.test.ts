import { describe, expect, it } from 'vitest';
import { normalizeAutomationExpression, parseWriteValue, stripHanCharacters } from './watch-expression-validation';

describe('Watch expression validation', () => {
  it('removes Han characters while preserving supported expression syntax', () => {
    expect(stripHanCharacters('p6啊')).toBe('p6');
    expect(stripHanCharacters('中文')).toBe('');
    expect(stripHanCharacters('p6,~@"/')).toBe('p6,~@"/');
    expect(stripHanCharacters('motor->kp + 1')).toBe('motor->kp + 1');
  });
});

describe('normalizeAutomationExpression (Unicode-preserving)', () => {
  it('preserves Han and every other character, only trimming', () => {
    expect(normalizeAutomationExpression('  p6啊->kp  ')).toEqual({ ok: true, expression: 'p6啊->kp' });
    expect(normalizeAutomationExpression('中文变量')).toEqual({ ok: true, expression: '中文变量' });
  });

  it('rejects empty and whitespace-only input', () => {
    expect(normalizeAutomationExpression('')).toMatchObject({ ok: false });
    expect(normalizeAutomationExpression('   ')).toMatchObject({ ok: false });
    expect(normalizeAutomationExpression(42)).toMatchObject({ ok: false });
    expect(normalizeAutomationExpression(undefined)).toMatchObject({ ok: false });
  });

  it('rejects control characters without rewriting them', () => {
    expect(normalizeAutomationExpression('a\u0000b')).toMatchObject({ ok: false });
    expect(normalizeAutomationExpression('a\u001Fb')).toMatchObject({ ok: false });
    expect(normalizeAutomationExpression('a\u007Fb')).toMatchObject({ ok: false });
  });
});

describe('parseWriteValue', () => {
  it('parses decimal, float and hex literals', () => {
    expect(parseWriteValue('42')).toBe(42);
    expect(parseWriteValue('3.14')).toBeCloseTo(3.14);
    expect(parseWriteValue('0xFF')).toBe(255);
    expect(parseWriteValue('0xffffffff')).toBe(0xffffffff);
    expect(parseWriteValue('-5')).toBe(-5);
  });

  it('rejects non-numeric and empty values', () => {
    expect(parseWriteValue('abc')).toBeUndefined();
    expect(parseWriteValue('')).toBeUndefined();
    expect(parseWriteValue('   ')).toBeUndefined();
    expect(parseWriteValue('1,2')).toBeUndefined();
  });
});
