import { BaseBrush } from "./base-brush";
import { gainBrush } from "./gain-brush";
import { transformBrush } from "./transform-brush";

export const brushes: Record<string, BaseBrush> = {
  gain: gainBrush,
  transform: transformBrush,
  // restore: restoreBrush,
  // blur: blurBrush,
  // "transient shaper": transientShaperBrush,
  // dynamics: dynamicsBrush,
  // scale: scaleBrush,
};

export type BrushType = keyof typeof brushes;
