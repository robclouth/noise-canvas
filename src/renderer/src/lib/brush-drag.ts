/**
 * Droppable id for the band titling a palette. The band is a drop target of its
 * own so a brush can be dragged onto a collapsed palette, which draws no brush
 * list to aim at.
 */
const HEADER_DROPPABLE_PREFIX = "palette-header:";

export function headerDroppableId(groupId: string): string {
  return `${HEADER_DROPPABLE_PREFIX}${groupId}`;
}

/** The palette a dropped brush joins, and its position in that palette. */
export type BrushDrop = { groupId: string; indexInGroup: number };

/** Where a brush dropped on `droppableId` lands. A header drop goes to the top. */
export function resolveBrushDrop(destination: { droppableId: string; index: number }): BrushDrop {
  if (destination.droppableId.startsWith(HEADER_DROPPABLE_PREFIX)) {
    return { groupId: destination.droppableId.slice(HEADER_DROPPABLE_PREFIX.length), indexInGroup: 0 };
  }
  return { groupId: destination.droppableId, indexInGroup: destination.index };
}
