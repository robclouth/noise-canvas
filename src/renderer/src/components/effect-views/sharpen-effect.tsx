import { ParameterControl } from "../controls/parameter-control";

export const SharpenEffect = () => {
  return (
    <>
      <ParameterControl paramKey="sharpenAmountTime" />
      <ParameterControl paramKey="sharpenAmountPitch" />
    </>
  );
};
