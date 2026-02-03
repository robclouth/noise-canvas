import { EFFECT_COLORS } from "@renderer/lib/constants";
import { memo } from "react";
import { ParameterControl } from "../controls/parameter-control";

const COLOR = EFFECT_COLORS.synthesize;

export const SynthesizeEffect = memo(function SynthesizeEffect() {
  return (
    <>
      <ParameterControl paramKey="synthesizeBrushType" color={COLOR} />
    </>
  );
});
