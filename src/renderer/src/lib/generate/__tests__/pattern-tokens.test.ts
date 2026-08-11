import { findBrushTokens } from "@renderer/lib/generate/pattern-tokens";
import { describe, expect, it } from "vitest";

const tokensOf = (code: string) => findBrushTokens(code).map((entry) => entry.token);

describe("findBrushTokens", () => {
  it("finds each value in a quoted string", () => {
    expect(tokensOf('"a b c"')).toEqual(["a", "b", "c"]);
  });

  it("ignores repeat counts and euclid arguments", () => {
    expect(tokensOf('"x*8"')).toEqual(["x"]);
    expect(tokensOf('"x(3,8)"')).toEqual(["x"]);
    expect(tokensOf('"x(<3 5>,8)"')).toEqual(["x"]);
    expect(tokensOf('"x@2 y!3"')).toEqual(["x", "y"]);
    expect(tokensOf('"kick:2"')).toEqual(["kick"]);
  });

  it("keeps digits that name a brush slot", () => {
    expect(tokensOf('"1 2 [3 4]"')).toEqual(["1", "2", "3", "4"]);
  });

  it("skips rests and grouping symbols", () => {
    expect(tokensOf('"a ~ [b <c d>]"')).toEqual(["a", "b", "c", "d"]);
  });

  it("looks only inside quoted strings", () => {
    expect(tokensOf('mini("a b").every(4, (p) => p.rev())')).toEqual(["a", "b"]);
  });

  it("reports offsets that select the token in the source", () => {
    const code = 'mini("ab cd")';
    const found = findBrushTokens(code);
    expect(found.map((entry) => code.slice(entry.from, entry.to))).toEqual(["ab", "cd"]);
  });

  it("handles several strings in one expression", () => {
    expect(tokensOf('stack("a*2", "b")')).toEqual(["a", "b"]);
  });
});
