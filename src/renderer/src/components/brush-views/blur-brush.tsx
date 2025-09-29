import { ParameterControl } from "../controls/parameter-control";

export const BlurBrush = () => {
  return (
    <>
      <ParameterControl key="blurAmountTime" paramKey="blurAmountTime" />
      <ParameterControl key="blurAmountPitch" paramKey="blurAmountPitch" />
      <ParameterControl key="blurNoiseTime" paramKey="blurNoiseTime" />
      <ParameterControl key="blurNoisePitch" paramKey="blurNoisePitch" />
      <ParameterControl key="blurBleed" paramKey="blurBleed" />
    </>
  );
};
