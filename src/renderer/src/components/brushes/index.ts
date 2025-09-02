import { blurBrush } from "./blur-brush";
import { gainBrush } from "./gain-brush";

export const brushes = {
  gain: gainBrush,
  blur: blurBrush,
};

export type BrushType = keyof typeof brushes;
