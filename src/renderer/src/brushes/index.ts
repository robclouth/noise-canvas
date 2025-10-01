import { BaseBrush } from "./base-brush";
import { blurBrush } from "./blur-brush";
import { gainBrush } from "./gain-brush";
import { harmonicsBrush } from "./harmonics-brush";
import { restoreBrush } from "./restore-brush";
import { sharpenBrush } from "./sharpen-brush";
import { synthesizeBrush } from "./synthesize-brush";
import { transformBrush } from "./transform-brush";

export const brushes: Record<string, BaseBrush> = {
  gain: gainBrush,
  transform: transformBrush,
  harmonics: harmonicsBrush,
  restore: restoreBrush,
  blur: blurBrush,
  synthesize: synthesizeBrush,
  sharpen: sharpenBrush,
  // "transient shaper": transientShaperBrush,
  // dynamics: dynamicsBrush,
  // scale: scaleBrush,
};

export type BrushType = keyof typeof brushes;
