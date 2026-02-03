import { EFFECT_COLORS } from "@renderer/lib/constants";
import { memo } from "react";
import { ParameterControl } from "../controls/parameter-control";

const COLOR = EFFECT_COLORS.dynamics;

export const DynamicsEffect = memo(function DynamicsEffect() {
  return (
    <>
      <ParameterControl paramKey="dynamicsThresholdDb" color={COLOR} />
      <ParameterControl paramKey="dynamicsUpperRatio" color={COLOR} />
      <ParameterControl paramKey="dynamicsLowerRatio" color={COLOR} />
      <ParameterControl paramKey="dynamicsKnee" color={COLOR} />
      <ParameterControl paramKey="dynamicsGainDb" color={COLOR} />
    </>
  );
});
