import { mini } from "@strudel/mini";
import { describe, expect, it } from "vitest";

describe("strudel", () => {
  it("queries a mini-notation pattern", () => {
    const haps = mini("a b [c c]").queryArc(0, 1);
    const onsets = haps.filter((h) => h.hasOnset());
    console.log(
      "hap sample:",
      JSON.stringify(
        onsets.map((h) => ({
          begin: h.whole?.begin.valueOf(),
          end: h.whole?.end.valueOf(),
          value: h.value,
          valueType: typeof h.value,
        })),
      ),
    );
    expect(onsets.length).toBe(4);
  });
});
