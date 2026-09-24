/** A small arithmetic grammar; never evaluates JavaScript or resolves identifiers. */
export function calculate(expression: string): number {
  if (expression.length > 1024) throw new Error('Expression exceeds 1024 characters');
  const tokens: string[] = [];
  const scanner = /\s*(?:(\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?|\*\*|[()+\-*/%^])/gy;
  let offset = 0;
  while (offset < expression.length) {
    if (expression.slice(offset).trim() === '') break;
    scanner.lastIndex = offset;
    const token = scanner.exec(expression);
    if (!token) throw new Error(`Invalid arithmetic expression at position ${offset}`);
    tokens.push(token[0].trim());
    offset = scanner.lastIndex;
    if (tokens.length > 256) throw new Error('Expression exceeds 256 tokens');
  }
  let index = 0;
  const peek = (): string | undefined => tokens[index];
  const consume = (): string | undefined => tokens[index++];
  const finite = (value: number): number => {
    if (!Number.isFinite(value)) throw new Error('Arithmetic result must be finite (check division by zero or overflow)');
    return value;
  };
  const primary = (): number => {
    const token = consume();
    if (token === '(') {
      const result = sum();
      if (consume() !== ')') throw new Error('Missing closing parenthesis');
      return result;
    }
    if (token === undefined || !/^(?:\d|\.)/.test(token)) throw new Error('Expected a number or parenthesized expression');
    return finite(Number(token));
  };
  const power = (): number => {
    const left = primary();
    if (peek() === '^' || peek() === '**') {
      consume();
      return finite(left ** unary());
    }
    return left;
  };
  const unary = (): number => {
    if (peek() === '+') { consume(); return unary(); }
    if (peek() === '-') { consume(); return -unary(); }
    return power();
  };
  const product = (): number => {
    let value = unary();
    while (peek() === '*' || peek() === '/' || peek() === '%') {
      const operator = consume();
      const right = unary();
      value = finite(operator === '*' ? value * right : operator === '/' ? value / right : value % right);
    }
    return value;
  };
  const sum = (): number => {
    let value = product();
    while (peek() === '+' || peek() === '-') {
      const operator = consume();
      const right = product();
      value = finite(operator === '+' ? value + right : value - right);
    }
    return value;
  };
  const result = sum();
  if (index !== tokens.length) throw new Error('Unexpected token in arithmetic expression');
  return result;
}
