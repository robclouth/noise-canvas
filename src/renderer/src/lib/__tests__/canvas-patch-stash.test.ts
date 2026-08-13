import { describe, expect, it } from "vitest";
import { clearCanvasPatchStash, setCanvasPatchStash, takeCanvasPatchStash } from "../canvas-patch-stash";

function makeStash() {
  return { data: new Float32Array(8), ranges: new Uint32Array([0, 2]) };
}

describe("canvas patch stash", () => {
  it("hands a stash to exactly one taker", () => {
    setCanvasPatchStash("a", makeStash());
    expect(takeCanvasPatchStash("a")).not.toBeNull();
    expect(takeCanvasPatchStash("a")).toBeNull();
  });

  it("keeps files apart", () => {
    setCanvasPatchStash("a", makeStash());
    expect(takeCanvasPatchStash("b")).toBeNull();
    expect(takeCanvasPatchStash("a")).not.toBeNull();
  });

  it("drops a cleared stash", () => {
    setCanvasPatchStash("a", makeStash());
    clearCanvasPatchStash("a");
    expect(takeCanvasPatchStash("a")).toBeNull();
  });
});
