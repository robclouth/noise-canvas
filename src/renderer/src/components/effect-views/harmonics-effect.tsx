import { ParameterControl } from "../controls/parameter-control";

export const HarmonicsEffect = () => {
  return (
    <>
      <ParameterControl paramKey="harmonicsPower" />
      <ParameterControl paramKey="harmonicsFalloff" />
    </>
  );
};
