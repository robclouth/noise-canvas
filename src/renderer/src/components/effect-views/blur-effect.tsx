import { ParameterControl } from "../controls/parameter-control";

export const BlurEffect = () => {
  return (
    <>
      <ParameterControl paramKey="blurAmountTime" />
      <ParameterControl paramKey="blurAmountPitch" />
      <ParameterControl paramKey="blurNoiseTime" />
      <ParameterControl paramKey="blurNoisePitch" />
      <ParameterControl paramKey="blurBleed" />
    </>
  );
};
