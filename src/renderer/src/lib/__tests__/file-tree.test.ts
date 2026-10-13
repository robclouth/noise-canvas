import { describe, expect, it } from "vitest";
import {
  addStep,
  currentLayers,
  focusLayerOfMove,
  layersNamed,
  mirrorOwnerTree,
  moveTo,
  parseFileTree,
  planLayers,
  redoTarget,
  undoTarget,
  withLayerAt,
  type FileTreeData,
} from "../file-tree";

/** An owner with a two-step history of its own: root → a → b. */
function ownerTree(): FileTreeData {
  return mirrorOwnerTree(
    "song",
    {
      root: { id: "root", parentId: null, childIds: ["a"], lastChildId: "a", timestamp: 1 },
      a: { id: "a", parentId: "root", childIds: ["b"], lastChildId: "b", timestamp: 2 },
      b: { id: "b", parentId: "a", childIds: [], lastChildId: null, timestamp: 3 },
    },
    "root",
    "b",
  );
}

/** Adds a layer as one step, then records an edit on `layerId` landing at `nodeId`. */
function addLayer(tree: FileTreeData, layerId: string): void {
  addStep(tree, { kind: "layers", label: "Add layer" }, [...currentLayers(tree), { layerId, nodeId: null }]);
}

function edit(tree: FileTreeData, layerId: string, nodeId: string): string {
  return addStep(tree, { kind: "edit", layerId }, withLayerAt(currentLayers(tree), layerId, nodeId));
}

/** Walks undo to the root, returning the layer each step showed. */
function undoAll(tree: FileTreeData): (string | null)[] {
  const shown: (string | null)[] = [];
  for (let target = undoTarget(tree); target; target = undoTarget(tree)) {
    shown.push(focusLayerOfMove(tree, tree.currentId, target));
    moveTo(tree, target);
  }
  return shown;
}

describe("the file tree", () => {
  it("mirrors the owner's own history, so undo walks on into the file's past", () => {
    const tree = ownerTree();
    expect(currentLayers(tree)).toEqual([{ layerId: "song", nodeId: "b" }]);
    expect(undoTarget(tree)).toBe("a");
    expect(tree.nodes.a.layers).toEqual([{ layerId: "song", nodeId: "a" }]);
    expect(tree.nodes.root.change).toBeNull();
  });

  it("undoes edits in the order they were made, whichever layer they were on", () => {
    const tree = ownerTree();
    addLayer(tree, "drums");
    edit(tree, "drums", "d1");
    edit(tree, "song", "c");
    edit(tree, "drums", "d2");

    expect(undoAll(tree)).toEqual(["drums", "song", "drums", null, "song", "song"]);
  });

  it("puts every layer back where it was at the node an undo reaches", () => {
    const tree = ownerTree();
    addLayer(tree, "drums");
    const afterDrums = edit(tree, "drums", "d1");
    edit(tree, "song", "c");

    moveTo(tree, undoTarget(tree)!);
    expect(tree.currentId).toBe(afterDrums);
    expect(currentLayers(tree)).toEqual([
      { layerId: "song", nodeId: "b" },
      { layerId: "drums", nodeId: "d1" },
    ]);
  });

  it("redoes the step it undid, and a new step after an undo starts a branch", () => {
    const tree = ownerTree();
    addLayer(tree, "drums");
    const first = edit(tree, "drums", "d1");
    moveTo(tree, undoTarget(tree)!);
    expect(redoTarget(tree)).toBe(first);

    const second = edit(tree, "song", "c");
    expect(tree.nodes[tree.nodes[second].parentId!].childIds).toEqual([first, second]);
    moveTo(tree, undoTarget(tree)!);
    expect(redoTarget(tree)).toBe(second);

    moveTo(tree, first);
    moveTo(tree, undoTarget(tree)!);
    expect(redoTarget(tree)).toBe(first);
  });

  it("plans which layers to hide, show and move between two configurations", () => {
    const plan = planLayers(
      [
        { layerId: "song", nodeId: "b" },
        { layerId: "drums", nodeId: "d1" },
      ],
      [
        { layerId: "song", nodeId: "c" },
        { layerId: "bass", nodeId: null },
      ],
    );
    expect(plan).toEqual({
      hide: ["drums"],
      show: ["bass"],
      move: [{ layerId: "song", nodeId: "c" }],
      order: ["song", "bass"],
    });
  });

  it("names every layer any node holds, including ones an undo has hidden", () => {
    const tree = ownerTree();
    addLayer(tree, "drums");
    moveTo(tree, undoTarget(tree)!);
    expect(currentLayers(tree).map((ref) => ref.layerId)).toEqual(["song"]);
    expect(layersNamed(tree)).toEqual(new Set(["song", "drums"]));
  });

  it("reads back what it stores, and refuses anything else", () => {
    const tree = ownerTree();
    addLayer(tree, "drums");
    expect(parseFileTree(JSON.stringify(tree))).toEqual(tree);
    expect(parseFileTree("not json")).toBeNull();
    expect(parseFileTree(JSON.stringify({ ...tree, version: 99 }))).toBeNull();
    expect(parseFileTree(JSON.stringify({ ...tree, currentId: "missing" }))).toBeNull();
  });
});
