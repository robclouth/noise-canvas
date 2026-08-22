import { describe, expect, it } from "vitest";

import { reorderFileIds, resolveFileDrop, type LaneBounds } from "../file-reorder";

// Three lanes stacked from y=100, each 200 tall, in a container whose top is 50.
const LANES: LaneBounds[] = [
  { fileId: "a", top: 100, bottom: 300 },
  { fileId: "b", top: 300, bottom: 500 },
  { fileId: "c", top: 500, bottom: 700 },
];

describe("resolving a file drop", () => {
  it("drops above the lane whose top half the pointer is in", () => {
    expect(resolveFileDrop(150, LANES, 50)?.beforeFileId).toBe("a");
    expect(resolveFileDrop(350, LANES, 50)?.beforeFileId).toBe("b");
  });

  it("drops below a lane once the pointer passes its middle", () => {
    expect(resolveFileDrop(250, LANES, 50)?.beforeFileId).toBe("b");
  });

  it("drops last when the pointer is past every lane", () => {
    expect(resolveFileDrop(900, LANES, 50)).toEqual({ beforeFileId: null, y: 650 });
  });

  it("places the indicator relative to the container", () => {
    expect(resolveFileDrop(350, LANES, 50)?.y).toBe(250);
  });

  it("has nowhere to drop when no lane is on screen", () => {
    expect(resolveFileDrop(350, [], 50)).toBeNull();
  });
});

describe("reordering the open files", () => {
  it("moves a file in front of another", () => {
    expect(reorderFileIds(["a", "b", "c"], "c", "b")).toEqual(["a", "c", "b"]);
  });

  it("moves a file to the end", () => {
    expect(reorderFileIds(["a", "b", "c"], "a", null)).toEqual(["b", "c", "a"]);
  });

  it("keeps the order when a file is dropped where it already is", () => {
    expect(reorderFileIds(["a", "b", "c"], "a", "b")).toEqual(["a", "b", "c"]);
  });

  it("leaves the order alone for a file that is not open", () => {
    const ids = ["a", "b"];
    expect(reorderFileIds(ids, "z", "a")).toBe(ids);
  });
});
