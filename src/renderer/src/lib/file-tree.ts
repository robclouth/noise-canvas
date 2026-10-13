/**
 * One history for a file with layers. Each layer keeps its own tree of states;
 * this tree orders the steps across all of them, so undo walks back through the
 * file as one unit. A node records the full layer configuration after its step:
 * which layers the file has, in tab order, and the node each layer is at.
 */

/**
 * A layer of the file, at a node of its own history. A null node is that
 * layer's root. The name is what its tab reads, when the step that made the
 * layer gave it one.
 */
export type LayerRef = { layerId: string; nodeId: string | null; name?: string };

/** What a step changed: one layer's state, or the set of layers itself. */
export type FileTreeChange = { kind: "edit"; layerId: string } | { kind: "layers"; label: string };

export interface FileTreeNode {
  id: string;
  parentId: string | null;
  childIds: string[];
  lastChildId: string | null;
  timestamp: number;
  /** Null on the root. */
  change: FileTreeChange | null;
  layers: LayerRef[];
}

export const FILE_TREE_VERSION = 1;

export interface FileTreeData {
  version: typeof FILE_TREE_VERSION;
  ownerId: string;
  rootId: string;
  currentId: string;
  nodes: Record<string, FileTreeNode>;
}

/** The shape of a layer's own history node that the mirror reads. */
export type MirroredNode = {
  id: string;
  parentId: string | null;
  childIds: string[];
  lastChildId: string | null;
  timestamp: number;
};

let idCounter = 0;

function nextNodeId(): string {
  idCounter++;
  return `ft_${Date.now().toString(36)}_${idCounter}`;
}

/**
 * A file tree that repeats the owner's own history node for node, so undo from
 * the first layered step walks straight on into the file's earlier states.
 */
export function mirrorOwnerTree(
  ownerId: string,
  nodes: Record<string, MirroredNode>,
  rootId: string,
  currentId: string,
): FileTreeData {
  const mirrored: Record<string, FileTreeNode> = {};
  for (const node of Object.values(nodes)) {
    mirrored[node.id] = {
      id: node.id,
      parentId: node.parentId,
      childIds: [...node.childIds],
      lastChildId: node.lastChildId,
      timestamp: node.timestamp,
      change: node.parentId === null ? null : { kind: "edit", layerId: ownerId },
      layers: [{ layerId: ownerId, nodeId: node.id }],
    };
  }
  return { version: FILE_TREE_VERSION, ownerId, rootId, currentId, nodes: mirrored };
}

/** The node the file is at. */
export function currentNode(tree: FileTreeData): FileTreeNode {
  return tree.nodes[tree.currentId];
}

/** The layers the file has at its current node, in tab order. */
export function currentLayers(tree: FileTreeData): LayerRef[] {
  return currentNode(tree).layers;
}

/** `layers` with `layerId` moved to `nodeId`, or unchanged when the file has no such layer. */
export function withLayerAt(layers: LayerRef[], layerId: string, nodeId: string | null): LayerRef[] {
  return layers.map((ref) => (ref.layerId === layerId ? { ...ref, nodeId } : ref));
}

/** Adds a step after the current node and moves to it. Returns the new node's id. */
export function addStep(
  tree: FileTreeData,
  change: FileTreeChange,
  layers: LayerRef[],
  timestamp = Date.now(),
): string {
  const parent = currentNode(tree);
  const id = nextNodeId();
  tree.nodes[id] = { id, parentId: parent.id, childIds: [], lastChildId: null, timestamp, change, layers };
  parent.childIds.push(id);
  parent.lastChildId = id;
  tree.currentId = id;
  return id;
}

/** The node an undo goes to, or null at the root. */
export function undoTarget(tree: FileTreeData): string | null {
  return currentNode(tree).parentId;
}

/** The node a redo goes to: the child last visited, or null when there is none. */
export function redoTarget(tree: FileTreeData): string | null {
  const node = currentNode(tree);
  return node.lastChildId ?? node.childIds[node.childIds.length - 1] ?? null;
}

/**
 * Moves the tree to `targetId`, and points each ancestor's last child along the
 * path to it, so a redo after an undo comes back the same way.
 */
export function moveTo(tree: FileTreeData, targetId: string): void {
  if (!tree.nodes[targetId]) return;
  let childId = targetId;
  let parentId = tree.nodes[targetId].parentId;
  while (parentId) {
    const parent = tree.nodes[parentId];
    if (!parent) break;
    parent.lastChildId = childId;
    childId = parentId;
    parentId = parent.parentId;
  }
  tree.currentId = targetId;
}

/**
 * The layer a move from `fromId` to `toId` shows: the layer an undone step had
 * changed, or the layer a redone step changes. Null when the step changed the
 * set of layers, or the nodes are not one step apart.
 */
export function focusLayerOfMove(tree: FileTreeData, fromId: string, toId: string): string | null {
  const from = tree.nodes[fromId];
  const to = tree.nodes[toId];
  if (!from || !to) return null;
  const step = from.parentId === toId ? from : to.parentId === fromId ? to : null;
  return step?.change?.kind === "edit" ? step.change.layerId : null;
}

/** What turning one layer configuration into another takes. */
export type LayerPlan = {
  /** Layers the target does not have. */
  hide: string[];
  /** Layers the target has that the current configuration does not. */
  show: string[];
  /** Layers on both sides whose node differs, with the node to go to. */
  move: LayerRef[];
  /** The target's tab order. */
  order: string[];
};

/** The steps from configuration `from` to configuration `to`. */
export function planLayers(from: LayerRef[], to: LayerRef[]): LayerPlan {
  const fromNode = new Map(from.map((ref) => [ref.layerId, ref.nodeId]));
  const toIds = new Set(to.map((ref) => ref.layerId));
  return {
    hide: from.filter((ref) => !toIds.has(ref.layerId)).map((ref) => ref.layerId),
    show: to.filter((ref) => !fromNode.has(ref.layerId)).map((ref) => ref.layerId),
    move: to.filter((ref) => fromNode.has(ref.layerId) && fromNode.get(ref.layerId) !== ref.nodeId),
    order: to.map((ref) => ref.layerId),
  };
}

/** Every layer any node of the tree names, so none of their histories is swept away. */
export function layersNamed(tree: FileTreeData): Set<string> {
  const ids = new Set<string>();
  for (const node of Object.values(tree.nodes)) for (const ref of node.layers) ids.add(ref.layerId);
  return ids;
}

/** Reads a stored tree, or null when it is missing, malformed or of another version. */
export function parseFileTree(json: string): FileTreeData | null {
  try {
    const parsed = JSON.parse(json) as Partial<FileTreeData>;
    if (parsed.version !== FILE_TREE_VERSION) return null;
    if (typeof parsed.ownerId !== "string" || typeof parsed.rootId !== "string") return null;
    if (typeof parsed.currentId !== "string" || !parsed.nodes || typeof parsed.nodes !== "object") return null;
    if (!parsed.nodes[parsed.currentId] || !parsed.nodes[parsed.rootId]) return null;
    return parsed as FileTreeData;
  } catch {
    return null;
  }
}
