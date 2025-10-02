import { useStore } from "@renderer/store";
import { ParameterControl } from "../controls/parameter-control";

export const BlurBrush = () => {
  const blurAmountTimeParameter = useStore((state) => state.blurAmountTime);
  const blurAmountPitchParameter = useStore((state) => state.blurAmountPitch);
  const blurNoiseTimeParameter = useStore((state) => state.blurNoiseTime);
  const blurNoisePitchParameter = useStore((state) => state.blurNoisePitch);
  const blurBleedParameter = useStore((state) => state.blurBleed);

  return (
    <>
      <ParameterControl parameter={blurAmountTimeParameter} />
      <ParameterControl parameter={blurAmountPitchParameter} />
      <ParameterControl parameter={blurNoiseTimeParameter} />
      <ParameterControl parameter={blurNoisePitchParameter} />
      <ParameterControl parameter={blurBleedParameter} />
    </>
  );
};
