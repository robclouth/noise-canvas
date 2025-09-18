import { BaseBrush } from "./base-brush";
import { blurBrush } from "./blur-brush";
import { convolveBrush } from "./convolve-brush";
import { dynamicsBrush } from "./dynamics-brush";
import { gainBrush } from "./gain-brush";
import { restoreBrush } from "./restore-brush";
import { scaleBrush } from "./scale-brush";
import { transformBrush } from "./transform-brush";
import { transientShaperBrush } from "./transient-shaper";

export const brushes: Record<string, BaseBrush> = {
  gain: gainBrush,
  restore: restoreBrush,
  blur: blurBrush,
  transform: transformBrush,
  "transient shaper": transientShaperBrush,
  dynamics: dynamicsBrush,
  convolve: convolveBrush,
  scale: scaleBrush,
};

export type BrushType = keyof typeof brushes;
