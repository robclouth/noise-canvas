import { describe, expect, it } from "vitest";

import { headerDroppableId, resolveBrushDrop } from "../brush-drag";

describe("resolveBrushDrop", () => {
  it("keeps the dropped position inside a brush list", () => {
    expect(resolveBrushDrop({ droppableId: "group-a", index: 3 })).toEqual({ groupId: "group-a", indexInGroup: 3 });
  });

  it("sends a header drop to the top of that palette", () => {
    expect(resolveBrushDrop({ droppableId: headerDroppableId("group-b"), index: 0 })).toEqual({
      groupId: "group-b",
      indexInGroup: 0,
    });
  });

  it("reads the group id back out of a header id that contains a colon", () => {
    expect(resolveBrushDrop({ droppableId: headerDroppableId("a:b:c"), index: 0 }).groupId).toBe("a:b:c");
  });
});
