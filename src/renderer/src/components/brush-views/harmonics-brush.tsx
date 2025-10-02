import { useStore } from "@renderer/store";
import { ParameterControl } from "../controls/parameter-control";

export const HarmonicsBrush = () => {
  const harmonicsPowerParameter = useStore((state) => state.harmonicsPower);
  const harmonicsFalloffParameter = useStore((state) => state.harmonicsFalloff);
  const harmonicsOddEvenParameter = useStore((state) => state.harmonicsOddEven);

  return (
    <>
      <ParameterControl parameter={harmonicsPowerParameter} />
      <ParameterControl parameter={harmonicsFalloffParameter} />
      <ParameterControl parameter={harmonicsOddEvenParameter} />
    </>
  );
};
