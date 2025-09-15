import { atom } from "jotai";
import { blurBrush } from "./blur-brush";
import { gainBrush } from "./gain-brush";
import { transformBrush } from "./transform-brush";
import { pitchShiftBrush } from "./pitch-shift-brush";
import { transientShaperBrush } from "./transient-shaper";
import { dynamicsBrush } from "./dynamics-brush";
import { convolveBrush } from "./convolve-brush";
import { harmonizerBrush } from "./harmonizer-brush";
import { restoreBrush } from "./restore-brush";
import { scaleBrush } from "./scale-brush";
import { BaseBrush } from "./base-brush";

export const brushes: Record<string, BaseBrush> = {
  gain: gainBrush,
  restore: restoreBrush,
  blur: blurBrush,
  "pitch shift": pitchShiftBrush,
  transform: transformBrush,
  "transient shaper": transientShaperBrush,
  dynamics: dynamicsBrush,
  convolve: convolveBrush,
  harmonizer: harmonizerBrush,
  scale: scaleBrush,
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
