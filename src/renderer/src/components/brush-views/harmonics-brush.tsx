import { ParameterControl } from "../controls/parameter-control";

export const HarmonicsBrush = () => {
  return (
    <>
      <ParameterControl key="harmonicsPower" paramKey="harmonicsPower" />
      <ParameterControl key="harmonicsFalloff" paramKey="harmonicsFalloff" />
      <ParameterControl key="harmonicsOddEven" paramKey="harmonicsOddEven" />
    </>
  );
};
