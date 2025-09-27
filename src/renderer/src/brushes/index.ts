import { BaseBrush } from "./base-brush";
import { gainBrush } from "./gain-brush";

export const brushes: Record<string, BaseBrush> = {
  gain: gainBrush,
  // restore: restoreBrush,
  // blur: blurBrush,
  // transform: transformBrush,
  // "transient shaper": transientShaperBrush,
  // dynamics: dynamicsBrush,
  // scale: scaleBrush,
};

export type BrushType = keyof typeof brushes;
