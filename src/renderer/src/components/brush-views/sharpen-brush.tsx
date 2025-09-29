import { ParameterControl } from "../controls/parameter-control";

export const SharpenBrush = () => {
  return (
    <>
      <ParameterControl key="sharpenAmountTime" paramKey="sharpenAmountTime" />
      <ParameterControl key="sharpenAmountPitch" paramKey="sharpenAmountPitch" />
    </>
  );
};
