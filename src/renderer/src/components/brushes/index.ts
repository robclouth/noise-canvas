import { atom } from "jotai";
import { blurBrush } from "./blur-brush";
import { gainBrush } from "./gain-brush";
import { transformBrush } from "./transform-brush";
import { pitchShiftBrush } from "./pitch-shift-brush";

export const brushes = {
  gain: gainBrush,
  blur: blurBrush,
  transform: transformBrush,
  pitchShift: pitchShiftBrush,
};

export type BrushType = keyof typeof brushes;

export const allBrushPropsAtom = atom((get) => {
  const props: Record<string, any> = {};
  for (const brush of Object.values(brushes)) {
    for (const param of brush.parameters) {
      props[param.propName] = get(param.atom as any);
    }
  }
  return props;
});
