const MAX_UINT32 = 0xFFFFFFFF;

/** Parses a small, side-effect-free integer expression without evaluating code. */
export function parseConstantExpression(expression: unknown): number | undefined {
  if (typeof expression !== 'string' || expression.trim() === '') return undefined;
  try {
    const parser = new ConstantExpressionParser(expression);
    const value = parser.parse();
    return value === undefined ? undefined : value;
  } catch {
    return undefined;
  }
}

class ConstantExpressionParser {
  private index = 0;

  constructor(private readonly source: string) {}

  parse(): number | undefined {
    const value = this.parseAdditive();
    this.skipWhitespace();
    return value !== undefined && this.index === this.source.length ? value : undefined;
  }

  private parseAdditive(): number | undefined {
    let value = this.parseMultiplicative();
    while (value !== undefined) {
      this.skipWhitespace();
      const operator = this.source[this.index];
      if (operator !== '+' && operator !== '-') return value;
      this.index++;
      const right = this.parseMultiplicative();
      if (right === undefined) return undefined;
      value = operator === '+' ? this.add(value, right) : this.subtract(value, right);
    }
    return undefined;
  }

  private parseMultiplicative(): number | undefined {
    let value = this.parseUnary();
    while (value !== undefined) {
      this.skipWhitespace();
      const operator = this.source[this.index];
      if (operator !== '*' && operator !== '/') return value;
      this.index++;
      const right = this.parseUnary();
      if (right === undefined) return undefined;
      value = operator === '*' ? this.multiply(value, right) : this.divide(value, right);
    }
    return undefined;
  }

  private parseUnary(): number | undefined {
    this.skipWhitespace();
    const operator = this.source[this.index];
    if (operator === '+' || operator === '-') {
      this.index++;
      const value = this.parseUnary();
      if (value === undefined || operator === '+') return value;
      return undefined;
    }
    return this.parsePrimary();
  }

  private parsePrimary(): number | undefined {
    this.skipWhitespace();
    if (this.source[this.index] === '(') {
      this.index++;
      const value = this.parseAdditive();
      this.skipWhitespace();
      if (this.source[this.index] !== ')') return undefined;
      this.index++;
      return value;
    }

    const start = this.index;
    if (this.source.slice(this.index, this.index + 2).toLowerCase() === '0x') {
      this.index += 2;
      const digitsStart = this.index;
      while (/[0-9a-f]/i.test(this.source[this.index] || '')) this.index++;
      if (this.index === digitsStart) return undefined;
    } else {
      while (/[0-9]/.test(this.source[this.index] || '')) this.index++;
      if (this.index === start) return undefined;
    }

    const value = Number(this.source.slice(start, this.index));
    return Number.isSafeInteger(value) && value >= 0 && value <= MAX_UINT32 ? value : undefined;
  }

  private add(left: number, right: number): number | undefined {
    return this.inRange(left + right) ? left + right : undefined;
  }

  private subtract(left: number, right: number): number | undefined {
    return this.inRange(left - right) ? left - right : undefined;
  }

  private multiply(left: number, right: number): number | undefined {
    return this.inRange(left * right) ? left * right : undefined;
  }

  private divide(left: number, right: number): number | undefined {
    if (right === 0 || left % right !== 0) return undefined;
    const value = left / right;
    return this.inRange(value) ? value : undefined;
  }

  private inRange(value: number): boolean {
    return Number.isSafeInteger(value) && value >= 0 && value <= MAX_UINT32;
  }

  private skipWhitespace() {
    while (/\s/.test(this.source[this.index] || '')) this.index++;
  }
}
