import { buildVisibleTree, layoutTree, MAX_FORK_BRANCHES } from "@renderer/lib/history-graph";
import type { HistoryNode } from "@renderer/lib/history-manager";
import { describe, expect, it } from "vitest";

const DIMENSIONS = {
  textureWidth: 4,
  textureHeight: 4,
  numFrames: 4,
  numBands: 4,
  numChannels: 1,
  sampleRate: 48000,
  minFreq: 20,
  bandsPerOctave: 12,
};

type NodeSpec = [id: string, parentId: string | null, label: string, timestamp?: number];

/**
 * Tree builder for the tests: `spec` lists nodes in the order they were made.
 * Timestamps follow that order unless one is given, and `childIds` /
 * `lastChildId` are filled the way HistoryManager fills them.
 */
function makeTree(spec: NodeSpec[]): Record<string, HistoryNode> {
  const nodes: Record<string, HistoryNode> = {};
  spec.forEach(([id, parentId, label, timestamp], i) => {
    nodes[id] = {
      id,
      parentId,
      childIds: [],
      lastChildId: null,
      timestamp: timestamp ?? 1000 + i,
      label,
      kind: parentId === null ? "root" : "stroke",
      storage: parentId === null ? "packed" : "delta",
      dimensions: DIMENSIONS,
    };
    if (parentId) {
      nodes[parentId].childIds.push(id);
      nodes[parentId].lastChildId = id;
    }
  });
  return nodes;
}

const NONE = new Set<string>();
const build = (
  nodes: Record<string, HistoryNode>,
  currentId: string,
  expanded: { runs?: Set<string>; forks?: Set<string> } = {},
) => buildVisibleTree(nodes, currentId, expanded.runs ?? NONE, expanded.forks ?? NONE);

/** `count` one-node branches hanging off `root`: retries from the same point. */
function retriesFrom(root: string, label: string, count: number): NodeSpec[] {
  return Array.from({ length: count }, (_, i) => [`${label}-try${i}`, root, label] as NodeSpec);
}

/**
 * Walks every edge of the laid-out tree and checks the drawing covers it: the
 * child's row draws a stub down, each row in between draws a bar in the child's
 * lane, and the parent's row draws either a stub up or a diagonal from that
 * lane. Also checks nothing is drawn where there is no edge.
 */
function assertEveryEdgeIsDrawn(tree: Record<string, HistoryNode>) {
  const layout = layoutTree(tree);
  const { rows, passThroughLanes, diagonals, sameLaneChild, parentEdge } = layout;
  const rowOf = new Map(rows.map((r) => [r.node.id, r.rowIndex]));
  const laneOf = new Map(rows.map((r) => [r.node.id, r.lane]));

  const expectedSameLaneChild = rows.map(() => false);
  const expectedParentEdge = rows.map(() => false);
  const expectedBars = rows.map(() => [] as number[]);
  const expectedDiagonals: string[] = [];

  for (const { node } of rows) {
    if (!node.parentId || !rowOf.has(node.parentId)) continue;
    const childRow = rowOf.get(node.id)!;
    const parentRow = rowOf.get(node.parentId)!;
    const childLane = laneOf.get(node.id)!;
    const parentLane = laneOf.get(node.parentId)!;

    // A parent below its child is what makes the edge drawable at all.
    expect(parentRow).toBeGreaterThan(childRow);

    expectedParentEdge[childRow] = true;
    for (let r = childRow + 1; r < parentRow; r++) expectedBars[r].push(childLane);
    if (childLane === parentLane) expectedSameLaneChild[parentRow] = true;
    else expectedDiagonals.push(`${parentRow}:${childLane}->${parentLane}`);
  }

  expect(sameLaneChild).toEqual(expectedSameLaneChild);
  expect(parentEdge).toEqual(expectedParentEdge);
  expect(passThroughLanes.map((l) => [...l].sort())).toEqual(expectedBars.map((l) => [...l].sort()));
  expect(diagonals.map((d) => `${d.rowIndex}:${d.fromLane}->${d.toLane}`).sort()).toEqual(expectedDiagonals.sort());

  // Two edges may share a lane only if they never overlap.
  const spans = rows
    .filter((r) => r.node.parentId && rowOf.has(r.node.parentId))
    .map((r) => ({ lane: r.lane, from: r.rowIndex, to: rowOf.get(r.node.parentId!)! }));
  for (const a of spans) {
    for (const b of spans) {
      if (a === b || a.lane !== b.lane) continue;
      expect(a.to <= b.from || b.to <= a.from).toBe(true);
    }
  }
  return layout;
}

const rowIds = (tree: Record<string, HistoryNode>) => layoutTree(tree).rows.map((r) => r.node.id);

describe("forks widen the graph", () => {
  it("keeps every branch of a small fork as its own row and its own lane", () => {
    const nodes = makeTree([["root", null, "Opened"], ...retriesFrom("root", "Blur", 3), ["kept", "root", "Blur"]]);
    const { tree, meta } = build(nodes, "kept");
    const layout = assertEveryEdgeIsDrawn(tree);

    // Nothing folded: root, four branches, no badges.
    expect(layout.rows).toHaveLength(5);
    expect([...meta.keys()]).toEqual([]);
    const branchLanes = layout.rows.filter((r) => r.node.id !== "root").map((r) => r.lane);
    expect(new Set(branchLanes).size).toBe(4);
  });

  it("folds an abandoned branch by its run, not by being a branch", () => {
    const nodes = makeTree([
      ["root", null, "Opened"],
      ["b1", "root", "Blur"],
      ["b2", "b1", "Blur"],
      ["b3", "b2", "Blur"],
      ["b4", "b3", "Blur"],
      ["kept", "root", "Pitch Up"],
    ]);
    const { tree, meta } = build(nodes, "kept");
    assertEveryEdgeIsDrawn(tree);

    // The branch keeps its own lane; its four identical steps fold into one row.
    expect(rowIds(tree)).toEqual(["kept", "b4", "root"]);
    expect(meta.get("b4")).toMatchObject({ kind: "run", count: 4 });
  });
});

describe("fork overflow", () => {
  const wideFork = () =>
    makeTree([
      ["root", null, "Opened"],
      ...retriesFrom("root", "Blur", MAX_FORK_BRANCHES + 2),
      ["kept", "root", "Blur"],
    ]);

  it("keeps the newest branches and folds the rest behind one badge", () => {
    const { tree, meta } = build(wideFork(), "kept");
    assertEveryEdgeIsDrawn(tree);

    const badge = "overflow:root";
    expect(rowIds(tree)).toHaveLength(MAX_FORK_BRANCHES + 1); // root + 4 branches + badge
    expect(meta.get(badge)).toMatchObject({ kind: "overflow", count: 4 });
    // The path the user is on is never the thing that folds.
    expect(rowIds(tree)).toContain("kept");
  });

  it("shows every branch once the fork is expanded", () => {
    const nodes = wideFork();
    const { tree, meta } = build(nodes, "kept", { forks: new Set(["root"]) });
    assertEveryEdgeIsDrawn(tree);

    expect(rowIds(tree)).toHaveLength(Object.keys(nodes).length);
    expect([...meta.keys()]).toEqual([]);
  });

  it("counts branches behind the badge, not nodes", () => {
    const spec: NodeSpec[] = [["root", null, "Opened"]];
    for (let i = 0; i < MAX_FORK_BRANCHES + 2; i++) {
      spec.push([`b${i}`, "root", "Blur"], [`b${i}-tail`, `b${i}`, "Blur"]);
    }
    spec.push(["kept", "root", "Blur"]);
    const { meta } = build(makeTree(spec), "kept");
    expect(meta.get("overflow:root")).toMatchObject({ count: 4 });
  });
});

describe("row order", () => {
  it("puts a parent below its children even when timestamps tie", () => {
    const nodes = makeTree([
      ["root", null, "Opened", 500],
      ["a", "root", "Blur", 100],
      ["b", "a", "Blur", 100],
      ["c", "b", "Pitch Up", 100],
    ]);
    const { tree } = build(nodes, "c");
    // Sorting on time alone would put root first and draw its edge backwards.
    expect(rowIds(tree)).toEqual(["c", "b", "a", "root"]);
    assertEveryEdgeIsDrawn(tree);
  });

  it("keeps a branch contiguous and leads with the most recent work", () => {
    const nodes = makeTree([
      ["root", null, "Opened"],
      ["old1", "root", "Old"],
      ["old2", "old1", "Old"],
      ["new1", "root", "New"],
      ["new2", "new1", "New"],
    ]);
    const { tree } = build(nodes, "new2");
    expect(rowIds(tree)).toEqual(["new2", "new1", "old2", "old1", "root"]);
    assertEveryEdgeIsDrawn(tree);
  });

  it("hangs an overflow badge off the fork it belongs to, and stops the run there", () => {
    const nodes = makeTree([
      ["root", null, "Paint"],
      ["a", "root", "Paint"],
      ["b", "a", "Paint"],
      ...retriesFrom("b", "Side", MAX_FORK_BRANCHES + 2),
      ["c", "b", "Paint"],
      ["d", "c", "Paint"],
    ]);
    const { tree, meta } = build(nodes, "root");
    // b keeps four branches plus the badge, so it is a fork and no run crosses it.
    expect(tree["overflow:b"].parentId).toBe("b");
    expect(meta.get("d")).toBeUndefined();
    assertEveryEdgeIsDrawn(tree);
  });
});

describe("run merging", () => {
  it("merges a straight chain of three or more", () => {
    const nodes = makeTree([
      ["root", null, "Opened"],
      ["a", "root", "Blur"],
      ["b", "a", "Blur"],
      ["c", "b", "Blur"],
      ["d", "c", "Pitch Up"],
    ]);
    const { tree, meta } = build(nodes, "d");
    expect(rowIds(tree)).toEqual(["d", "c", "root"]);
    expect(meta.get("c")).toMatchObject({ kind: "run", count: 3, runNodeIds: ["c", "b", "a"] });
  });

  it("leaves the current node out of a run", () => {
    const nodes = makeTree([
      ["root", null, "Opened"],
      ["a", "root", "Blur"],
      ["b", "a", "Blur"],
      ["c", "b", "Blur"],
    ]);
    const { tree, meta } = build(nodes, "b");
    expect(rowIds(tree)).toEqual(["c", "b", "a", "root"]);
    expect([...meta.keys()]).toEqual([]);
  });

  it("stops at a real fork", () => {
    const nodes = makeTree([
      ["root", null, "Opened"],
      ["a", "root", "Blur"],
      ["b", "a", "Blur"],
      ["side", "b", "Blur"],
      ["c", "b", "Blur"],
      ["d", "c", "Pitch Up"],
    ]);
    const { meta } = build(nodes, "d");
    // b has two real children, so the chain above it is only c — too short.
    expect([...meta.keys()]).toEqual([]);
  });

  it("shows the run's nodes again when it is expanded", () => {
    const nodes = makeTree([
      ["root", null, "Opened"],
      ["a", "root", "Blur"],
      ["b", "a", "Blur"],
      ["c", "b", "Blur"],
      ["d", "c", "Pitch Up"],
    ]);
    const { tree } = build(nodes, "d", { runs: new Set(["c"]) });
    expect(rowIds(tree)).toEqual(["d", "c", "b", "a", "root"]);
    assertEveryEdgeIsDrawn(tree);
  });
});

describe("malformed trees", () => {
  it("keeps a node whose parent is gone, and draws no edge for it", () => {
    const nodes = makeTree([
      ["root", null, "Opened"],
      ["kept", "root", "Blur"],
    ]);
    nodes["orphan"] = { ...nodes["kept"], id: "orphan", parentId: "vanished", childIds: [] };
    const { tree } = build(nodes, "kept");
    expect(rowIds(tree)).toContain("orphan");
    // No stub is drawn under it, so nothing points at a row that is not there.
    const layout = layoutTree(tree);
    const orphanRow = layout.rows.find((r) => r.node.id === "orphan")!;
    expect(layout.parentEdge[orphanRow.rowIndex]).toBe(false);
  });

  it("does not hang on a cycle", () => {
    const nodes = makeTree([
      ["root", null, "Opened"],
      ["a", "root", "Blur"],
      ["b", "a", "Blur"],
    ]);
    nodes["a"].parentId = "b";
    nodes["b"].childIds.push("a");
    const { tree } = build(nodes, "b");
    expect(layoutTree(tree).rows.length).toBeGreaterThan(0);
  });
});
