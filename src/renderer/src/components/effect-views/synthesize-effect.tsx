import { EFFECT_COLORS } from "@renderer/lib/constants";
import { ParameterControl } from "../controls/parameter-control";

const COLOR = EFFECT_COLORS.synthesize;

export const SynthesizeEffect = () => {
  return (
    <>
      <ParameterControl paramKey="synthesizeBrushType" color={COLOR} />
    </>
  );
};
