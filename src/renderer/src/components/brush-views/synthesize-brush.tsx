import { useStore } from "@renderer/store";
import { ParameterControl } from "../controls/parameter-control";

export const SynthesizeBrush = () => {
  const synthesizeBrushTypeParameter = useStore((state) => state.synthesizeBrushType);

  return (
    <>
      <ParameterControl parameter={synthesizeBrushTypeParameter} />
    </>
  );
};
