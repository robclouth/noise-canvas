import { BaseBrush } from "./base-brush";
import { blurBrush } from "./blur-brush";
import { gainBrush } from "./gain-brush";
import { restoreBrush } from "./restore-brush";
import { sharpenBrush } from "./sharpen-brush";
import { transformBrush } from "./transform-brush";

export const brushes: Record<string, BaseBrush> = {
  gain: gainBrush,
  transform: transformBrush,
  restore: restoreBrush,
  blur: blurBrush,
  sharpen: sharpenBrush,
  // "transient shaper": transientShaperBrush,
  // dynamics: dynamicsBrush,
  // scale: scaleBrush,
};

export type BrushType = keyof typeof brushes;
