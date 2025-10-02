import { useStore } from "@renderer/store";
import { ParameterControl } from "../controls/parameter-control";

export const TransformBrush = () => {
  const transformShiftBeatsParameter = useStore((state) => state.transformShiftBeats);
  const transformShiftSemisParameter = useStore((state) => state.transformShiftSemis);
  const transformScaleTimeParameter = useStore((state) => state.transformScaleTime);
  const transformScalePitchParameter = useStore((state) => state.transformScalePitch);
  const transformRotationParameter = useStore((state) => state.transformRotation);
  const transformEdgeModeParameter = useStore((state) => state.transformEdgeMode);

  return (
    <>
      <ParameterControl parameter={transformShiftBeatsParameter} />
      <ParameterControl parameter={transformShiftSemisParameter} />
      <ParameterControl parameter={transformScaleTimeParameter} />
      <ParameterControl parameter={transformScalePitchParameter} />
      <ParameterControl parameter={transformRotationParameter} />
      <ParameterControl parameter={transformEdgeModeParameter} />
    </>
  );
};
