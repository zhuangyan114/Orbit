const HAN_CHARACTERS = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\u{20000}-\u{323AF}]/gu;

/** Removes Han characters while preserving punctuation and other expression syntax. */
export function stripHanCharacters(expression: string): string {
  return expression.replace(HAN_CHARACTERS, '');
}
