import { modulatorViewRefAtom } from "@/store";
import { Box } from "@mantine/core";
import { useAtomValue } from "jotai";
import React from "react";
import { Section } from "./section";

export const Modulator: React.FC = () => {
  const modulatorViewRef = useAtomValue(modulatorViewRefAtom);

  return (
    <Section label="Modulator">
      {/* <SelectControl label="Mode" atom={modeAtom} data={MODULATOR_MODES.map((m) => m.value)} /> */}
      {/* {modulatorState.mode === "lfo" && (
        <>
          <SelectControl label="Shape" atom={shapeAtom} data={LFO_SHAPES.map((s) => s.value)} />
          <SliderControl label="Time Rate" atom={timeRateAtom} min={0.1} max={10} step={0.1} />
          <SliderControl label="Pitch Rate" atom={pitchRateAtom} min={0.1} max={10} step={0.1} />
        </>
      )} */}
      <Box ref={modulatorViewRef} h={128} mt="sm" />
    </Section>
  );
};
