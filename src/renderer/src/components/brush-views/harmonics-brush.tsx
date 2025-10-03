import { ParameterControl } from "../controls/parameter-control";

export const HarmonicsBrush = () => {
  return (
    <>
      <ParameterControl paramKey="harmonicsPower" />
      <ParameterControl paramKey="harmonicsFalloff" />
      <ParameterControl paramKey="harmonicsOddEven" />
    </>
  );
};
