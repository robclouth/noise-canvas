import { ParameterControl } from "../controls/parameter-control";

export const HarmonicsEffect = () => {
  return (
    <>
      <ParameterControl paramKey="overtonesCount" />
      <ParameterControl paramKey="overtonesScale" />
      <ParameterControl paramKey="overtonesDecay" />
      <ParameterControl paramKey="overtonesShape" />
    </>
  );
};
