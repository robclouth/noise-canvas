import { ParameterControl } from "../controls/parameter-control";

export const SharpenBrush = () => {
  return (
    <>
      <ParameterControl paramKey="sharpenAmountTime" />
      <ParameterControl paramKey="sharpenAmountPitch" />
    </>
  );
};
