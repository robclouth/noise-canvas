import { EFFECT_COLORS } from "@renderer/lib/constants";
import { ParameterControl } from "../controls/parameter-control";

const COLOR = EFFECT_COLORS.overtones;

export const HarmonicsEffect = () => {
  return (
    <>
      <ParameterControl paramKey="overtonesCount" color={COLOR} />
      <ParameterControl paramKey="overtonesScale" color={COLOR} />
      <ParameterControl paramKey="overtonesDecay" color={COLOR} />
      <ParameterControl paramKey="overtonesShape" color={COLOR} />
    </>
  );
};
