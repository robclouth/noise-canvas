import { EFFECT_COLORS } from "@renderer/lib/constants";
import { ParameterControl } from "../controls/parameter-control";

const COLOR = EFFECT_COLORS.dynamics;

export const DynamicsEffect = () => {
  return (
    <>
      <ParameterControl paramKey="dynamicsThresholdDb" color={COLOR} />
      <ParameterControl paramKey="dynamicsUpperRatio" color={COLOR} />
      <ParameterControl paramKey="dynamicsLowerRatio" color={COLOR} />
      <ParameterControl paramKey="dynamicsKnee" color={COLOR} />
      <ParameterControl paramKey="dynamicsGainDb" color={COLOR} />
    </>
  );
};
