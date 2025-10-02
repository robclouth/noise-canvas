import { useStore } from "@renderer/store";
import { ParameterControl } from "../controls/parameter-control";

export const SharpenBrush = () => {
  const sharpenAmountTimeParameter = useStore((state) => state.sharpenAmountTime);
  const sharpenAmountPitchParameter = useStore((state) => state.sharpenAmountPitch);

  return (
    <>
      <ParameterControl parameter={sharpenAmountTimeParameter} />
      <ParameterControl parameter={sharpenAmountPitchParameter} />
    </>
  );
};
