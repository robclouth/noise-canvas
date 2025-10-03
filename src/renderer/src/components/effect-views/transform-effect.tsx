import { ParameterControl } from "../controls/parameter-control";

export const TransformEffect = () => {
  return (
    <>
      <ParameterControl paramKey="transformShiftBeats" />
      <ParameterControl paramKey="transformShiftSemis" />
      <ParameterControl paramKey="transformScaleTime" />
      <ParameterControl paramKey="transformScalePitch" />
      <ParameterControl paramKey="transformRotation" />
      <ParameterControl paramKey="transformEdgeMode" />
    </>
  );
};
