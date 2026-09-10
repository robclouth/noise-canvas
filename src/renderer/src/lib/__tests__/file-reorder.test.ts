import { describe, expect, it } from "vitest";

import { gatherFileGroups, gatherFileIds, reorderFileIds, resolveFileDrop, type LayerBounds } from "../file-reorder";

// Three layers stacked from y=100, each 200 tall, in a container whose top is 50.
const LANES: LayerBounds[] = [
  { fileId: "a", top: 100, bottom: 300, stackId: null },
  { fileId: "b", top: 300, bottom: 500, stackId: null },
  { fileId: "c", top: 500, bottom: 700, stackId: null },
];

describe("resolving a file drop", () => {
  it("drops above the layer whose top half the pointer is in", () => {
    expect(resolveFileDrop(150, LANES, 50)?.beforeFileId).toBe("a");
    expect(resolveFileDrop(350, LANES, 50)?.beforeFileId).toBe("b");
  });

  it("drops below a layer once the pointer passes its middle", () => {
    expect(resolveFileDrop(250, LANES, 50)?.beforeFileId).toBe("b");
  });

  it("drops last when the pointer is past every layer", () => {
    expect(resolveFileDrop(900, LANES, 50)).toEqual({ beforeFileId: null, stackId: null, y: 650 });
  });

  it("places the indicator relative to the container", () => {
    expect(resolveFileDrop(350, LANES, 50)?.y).toBe(250);
  });

  it("has nowhere to drop when no layer is on screen", () => {
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

describe("gathering files into one run", () => {
  it("pulls scattered members up to where the first one sits", () => {
    expect(gatherFileIds(["a", "b", "c", "d", "e"], ["b", "d"])).toEqual(["a", "b", "d", "c", "e"]);
  });

  it("keeps the members in canvas order, not the order they were picked", () => {
    expect(gatherFileIds(["a", "b", "c"], ["c", "a"])).toEqual(["a", "c", "b"]);
  });

  it("leaves a run that is already contiguous where it is", () => {
    expect(gatherFileIds(["a", "b", "c"], ["a", "b"])).toEqual(["a", "b", "c"]);
  });

  it("ignores ids that are not open", () => {
    expect(gatherFileIds(["a", "b", "c"], ["c", "z"])).toEqual(["a", "b", "c"]);
  });

  it("leaves the order alone when none of the ids are open", () => {
    const ids = ["a", "b"];
    expect(gatherFileIds(ids, ["z"])).toBe(ids);
  });
});

// A loose layer, then a two-member group, then another loose layer. The 40 px
// above the group's first member is its header strip, which is not a layer.
const WITH_GROUP: LayerBounds[] = [
  { fileId: "loose", top: 100, bottom: 300, stackId: null },
  { fileId: "m1", top: 340, bottom: 540, stackId: "g1" },
  { fileId: "m2", top: 540, bottom: 740, stackId: "g1" },
  { fileId: "after", top: 740, bottom: 940, stackId: null },
];

describe("which group a drop lands in", () => {
  it("joins the group when the pointer is between its members", () => {
    expect(resolveFileDrop(530, WITH_GROUP, 0)).toMatchObject({ beforeFileId: "m2", stackId: "g1" });
  });

  it("joins at the top when the pointer is in the first member's top half", () => {
    expect(resolveFileDrop(360, WITH_GROUP, 0)).toMatchObject({ beforeFileId: "m1", stackId: "g1" });
  });

  it("joins at the end when the pointer is in the last member's bottom half", () => {
    expect(resolveFileDrop(700, WITH_GROUP, 0)).toMatchObject({ beforeFileId: "after", stackId: "g1" });
  });

  it("stays outside when the pointer is on the header strip above the group", () => {
    expect(resolveFileDrop(320, WITH_GROUP, 0)).toMatchObject({ beforeFileId: "m1", stackId: null });
  });

  it("stays outside over a loose layer", () => {
    expect(resolveFileDrop(150, WITH_GROUP, 0)).toMatchObject({ beforeFileId: "loose", stackId: null });
    expect(resolveFileDrop(800, WITH_GROUP, 0)).toMatchObject({ beforeFileId: "after", stackId: null });
  });

  it("stays outside past the last layer", () => {
    expect(resolveFileDrop(2000, WITH_GROUP, 0)).toMatchObject({ beforeFileId: null, stackId: null });
  });

  it("keeps two touching groups apart", () => {
    const layers: LayerBounds[] = [
      { fileId: "a1", top: 0, bottom: 100, stackId: "g1" },
      { fileId: "a2", top: 100, bottom: 200, stackId: "g1" },
      { fileId: "b1", top: 240, bottom: 340, stackId: "g2" },
      { fileId: "b2", top: 340, bottom: 440, stackId: "g2" },
    ];

    expect(resolveFileDrop(180, layers, 0)?.stackId).toBe("g1");
    expect(resolveFileDrop(220, layers, 0)?.stackId).toBeNull();
    expect(resolveFileDrop(260, layers, 0)?.stackId).toBe("g2");
  });
});

describe("closing groups back into one run", () => {
  it("pulls a group shut around a file that got between its members", () => {
    const ids = gatherFileGroups(["m1", "loose", "m2", "other"], { m1: "g1", m2: "g1" });
    expect(ids).toEqual(["m1", "m2", "loose", "other"]);
  });

  it("leaves a group that is already one run alone", () => {
    const ids = gatherFileGroups(["m1", "m2", "loose"], { m1: "g1", m2: "g1" });
    expect(ids).toEqual(["m1", "m2", "loose"]);
  });

  it("closes several groups independently", () => {
    const ids = gatherFileGroups(["a1", "b1", "a2", "b2"], { a1: "g1", a2: "g1", b1: "g2", b2: "g2" });
    expect(ids).toEqual(["a1", "a2", "b1", "b2"]);
  });

  it("leaves an order with no groups in it alone", () => {
    const ids = ["a", "b", "c"];
    expect(gatherFileGroups(ids, {})).toBe(ids);
  });
});
