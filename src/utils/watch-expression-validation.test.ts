import { describe, expect, it } from 'vitest';
import { stripHanCharacters } from './watch-expression-validation';

describe('Watch expression validation', () => {
  it('removes Han characters while preserving supported expression syntax', () => {
    expect(stripHanCharacters('p6啊')).toBe('p6');
    expect(stripHanCharacters('中文')).toBe('');
    expect(stripHanCharacters('p6,~@"/')).toBe('p6,~@"/');
    expect(stripHanCharacters('motor->kp + 1')).toBe('motor->kp + 1');
  });
});
