import { ParameterControl } from "../controls/parameter-control";

export const TransformBrush = () => {
  return (
    <>
      <ParameterControl key="transformShiftBeats" paramKey="transformShiftBeats" />
      <ParameterControl key="transformShiftSemis" paramKey="transformShiftSemis" />
      <ParameterControl key="transformScaleTime" paramKey="transformScaleTime" />
      <ParameterControl key="transformScalePitch" paramKey="transformScalePitch" />
      <ParameterControl key="transformRotation" paramKey="transformRotation" />
      <ParameterControl key="transformEdgeMode" paramKey="transformEdgeMode" />
    </>
  );
};
