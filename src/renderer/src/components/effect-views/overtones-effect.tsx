import { EFFECT_COLORS } from "@renderer/lib/constants";
import { memo } from "react";
import { ParameterControl } from "../controls/parameter-control";

const COLOR = EFFECT_COLORS.overtones;

export const HarmonicsEffect = memo(function HarmonicsEffect() {
  return (
    <>
      <ParameterControl paramKey="overtonesCount" color={COLOR} />
      <ParameterControl paramKey="overtonesScale" color={COLOR} />
      <ParameterControl paramKey="overtonesDecay" color={COLOR} />
      <ParameterControl paramKey="overtonesShape" color={COLOR} />
    </>
  );
});
