import { ParameterControl } from "../controls/parameter-control";

export const DynamicsEffect = () => {
  return (
    <>
      <ParameterControl paramKey="dynamicsThresholdDb" />
      <ParameterControl paramKey="dynamicsUpperRatio" />
      <ParameterControl paramKey="dynamicsLowerRatio" />
      <ParameterControl paramKey="dynamicsKnee" />
      <ParameterControl paramKey="dynamicsGainDb" />
    </>
  );
};
