import { EFFECT_COLORS } from "@renderer/lib/constants";
import { ParameterControl } from "../controls/parameter-control";

const COLOR = EFFECT_COLORS.blur;

export const BlurEffect = () => {
  return (
    <>
      <ParameterControl paramKey="blurAmountTime" color={COLOR} />
      <ParameterControl paramKey="blurAmountPitch" color={COLOR} />
      <ParameterControl paramKey="blurNoiseTime" color={COLOR} />
      <ParameterControl paramKey="blurNoisePitch" color={COLOR} />
      <ParameterControl paramKey="blurBleed" color={COLOR} />
      <ParameterControl paramKey="blurOrigin" color={COLOR} />
    </>
  );
};
