import { useStore } from "@renderer/store";
import { ParameterControl } from "../controls/parameter-control";

export const GainBrush = () => {
  const gainDbParameter = useStore((state) => state.gainDb);
  return (
    <>
      <ParameterControl parameter={gainDbParameter} />
    </>
  );
};
