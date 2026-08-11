export interface PatternToken {
  /** Offset of the token's first character in the pattern source. */
  from: number;
  /** Offset one past the token's last character. */
  to: number;
  token: string;
}

const TOKEN_CHARS = /[A-Za-z0-9#'.-]/;
/** Characters that make the token after them an argument rather than a brush name. */
const ARGUMENT_PREFIXES = "*/!@:%";

/**
 * Finds the brush references inside a pattern's quoted strings. Tokens in
 * argument position — after `*`, `@`, `!`, `/`, `:` or inside `(...)` — are
 * repeat counts and euclid arguments rather than brush names, so `"x*8"` names
 * only `x`.
 */
export function findBrushTokens(code: string): PatternToken[] {
  const found: PatternToken[] = [];
  const strings = /"([^"]*)"/g;
  let quoted: RegExpExecArray | null;

  while ((quoted = strings.exec(code)) !== null) {
    const inner = quoted[1];
    const base = quoted.index + 1;
    let index = 0;
    let depth = 0;
    let previous = "";

    while (index < inner.length) {
      const char = inner[index];
      if (TOKEN_CHARS.test(char)) {
        const start = index;
        while (index < inner.length && TOKEN_CHARS.test(inner[index])) index++;
        const token = inner.slice(start, index);
        const isArgument = depth > 0 || (previous !== "" && ARGUMENT_PREFIXES.includes(previous));
        if (!isArgument) {
          found.push({ from: base + start, to: base + index, token });
        }
        previous = token[token.length - 1];
        continue;
      }
      if (char === "(") depth++;
      else if (char === ")") depth = Math.max(0, depth - 1);
      if (!/\s/.test(char)) previous = char;
      index++;
    }
  }
  return found;
}
