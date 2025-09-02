import { BrushType } from "../../store";
import { BaseBrush } from "./base-brush";
import { blurBrush } from "./blur-brush";
import { gainBrush } from "./gain-brush";

export const brushes: Record<BrushType, BaseBrush> = {
  gain: gainBrush,
  blur: blurBrush,
};
