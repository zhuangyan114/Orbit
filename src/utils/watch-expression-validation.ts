const HAN_CHARACTERS = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\u{20000}-\u{323AF}]/gu;

/** Removes Han characters while preserving punctuation and other expression syntax. */
export function stripHanCharacters(expression: string): string {
  return expression.replace(HAN_CHARACTERS, '');
}

// --- Automation expression boundary (plan Task 8) --------------------------
// The Automation API must preserve every character of an expression — it only
// trims and rejects empty input. Unlike the Watch UI boundary above (which
// intentionally strips Han characters), the automation path never rewrites an
// expression: a legacy expression that would need migration is rejected whole
// as InvalidExpression rather than being silently altered.

const CONTROL_CHARACTERS = /[\u0000-\u001F\u007F]/;

export type NormalizeExpressionResult =
  | { ok: true; expression: string }
  | { ok: false; reason: string };

/**
 * Unicode-preserving expression normalization for the Automation API. The
 * caller maps `{ ok: false }` onto the frozen `InvalidExpression` error and
 * must NOT fall back to a stripped/rewritten expression.
 */
export function normalizeAutomationExpression(input: unknown): NormalizeExpressionResult {
  if (typeof input !== 'string') return { ok: false, reason: 'expression must be a string' };
  const trimmed = input.trim();
  if (!trimmed) return { ok: false, reason: 'expression must not be empty' };
  if (CONTROL_CHARACTERS.test(trimmed)) return { ok: false, reason: 'expression contains control characters' };
  return { ok: true, expression: trimmed };
}

/**
 * Parses an automation write value (a frozen `Expression` string) into the
 * finite JS number the backend `setWatchValue` core expects. Accepts decimal,
 * float and `0x`-prefixed hex literals; returns `undefined` when the value is
 * not a single finite number.
 */
export function parseWriteValue(input: string): number | undefined {
  const value = input.trim();
  if (!value) return undefined;
  const hex = /^[+-]?0[xX][0-9a-fA-F]+$/.test(value);
  let numeric: number;
  if (hex) {
    const negative = value.startsWith('-');
    numeric = Number.parseInt(value.replace(/^[+-]?0[xX]/, ''), 16);
    if (negative) numeric = -numeric;
  } else {
    numeric = Number(value);
  }
  return Number.isFinite(numeric) ? numeric : undefined;
}
