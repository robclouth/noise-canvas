import { EFFECT_COLORS } from "@renderer/lib/constants";
import { ParameterControl } from "../controls/parameter-control";

const COLOR = EFFECT_COLORS.evolve;

export const EvolveEffect = () => {
  return (
    <>
      <ParameterControl paramKey="evolveFlow" color={COLOR} />
      <ParameterControl paramKey="evolveSpread" color={COLOR} />
      <ParameterControl paramKey="evolveGrow" color={COLOR} />
      <ParameterControl paramKey="evolveSwirl" color={COLOR} />
      <ParameterControl paramKey="evolveDriftX" color={COLOR} />
      <ParameterControl paramKey="evolveDriftY" color={COLOR} />
      <ParameterControl paramKey="evolveDecay" color={COLOR} />
      <ParameterControl paramKey="evolveScaleX" color={COLOR} />
      <ParameterControl paramKey="evolveScaleY" color={COLOR} />
      <ParameterControl paramKey="evolveEdgeMode" color={COLOR} />
    </>
  );
};
