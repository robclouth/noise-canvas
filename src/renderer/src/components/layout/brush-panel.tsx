import { brushes } from "@/components/brushes";
import { ParameterControl } from "@/components/controls/parameter-control";
import { SelectControl } from "@/components/controls/select-control";
import { beatValues, pitchValues } from "@/lib/constants";
import {
  blendModeAtom,
  brushHeightAtom,
  brushIntensityAtom,
  brushSizeLockedToGridAtom,
  brushTypeAtom,
  brushWidthAtom,
  featherXAtom,
  featherYAtom,
  gridSizeAtom,
  gridSizeYAtom,
  offsetLockAtom,
  offsetXAtom,
  offsetYAtom,
  panAtom,
} from "@/store";
import { Flex } from "@mantine/core";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { useEffect } from "react";
import { SliderControl } from "../controls/slider-control";
import { SwitchControl } from "../controls/switch-control";
import { Section } from "../section";

export function BrushPanel() {
  const [brushType] = useAtom(brushTypeAtom);

  const brushSizeLocked = useAtomValue(brushSizeLockedToGridAtom);
  const [gridSize] = useAtom(gridSizeAtom);
  const [gridSizeY] = useAtom(gridSizeYAtom);
  const setBrushWidth = useSetAtom(brushWidthAtom);
  const setBrushHeight = useSetAtom(brushHeightAtom);

  useEffect(() => {
    if (brushSizeLocked) {
      setBrushWidth(gridSize);
      setBrushHeight(gridSizeY);
    }
  }, [brushSizeLocked, gridSize, gridSizeY, setBrushWidth, setBrushHeight]);

  const brush = brushes[brushType];
  return (
    <Flex direction="column" w={300} p="xs">
      <Section label="Size">
        <SwitchControl label="Grid" atom={brushSizeLockedToGridAtom} />
        <SliderControl
          label="Width"
          atom={brushWidthAtom}
          values={[...beatValues, { label: "Full", value: 0 }]}
          disabled={brushSizeLocked}
        />
        <SliderControl
          label="Height"
          atom={brushHeightAtom}
          values={[...pitchValues, { label: "Full", value: 0 }]}
          disabled={brushSizeLocked}
        />
      </Section>
      <Section label="Output">
        <SliderControl label="Intensity" atom={brushIntensityAtom} min={0} max={100} step={1} unit="%" />
        <SliderControl label="Pan" atom={panAtom} min={-1} max={1} step={0.01} />
        <SelectControl
          label="Blend"
          atom={blendModeAtom}
          data={["Normal", "Maximum", "Minimum", "Dissolve", "Multiply", "Difference", "Subtract", "Divide"]}
        />
      </Section>
      <Section label="Feather">
        <SliderControl label="Time" atom={featherXAtom} min={0} max={100} step={1} unit="%" />
        <SliderControl label="Pitch" atom={featherYAtom} min={0} max={100} step={1} unit="%" />
      </Section>
      <Section label="Offset">
        <SliderControl
          label="Time"
          atom={offsetXAtom}
          values={[
            ...beatValues.map((v) => ({ value: -v.value, label: `-${v.label}` })).reverse(),
            { label: "0 beats", value: 0 },
            ...beatValues,
          ]}
        />
        <SliderControl label="Pitch" atom={offsetYAtom} min={-48} max={48} step={1} unit=" semis" />
        <SwitchControl label="Lock" atom={offsetLockAtom} />
      </Section>
      <Section label="Brush">
        <SelectControl
          label="Brush"
          atom={brushTypeAtom}
          data={Object.keys(brushes).map((key) => ({
            value: key,
            label: key.charAt(0).toUpperCase() + key.slice(1),
          }))}
        />
        {brush ? brush.parameters.map((param) => <ParameterControl key={param.label} parameter={param} />) : null}
      </Section>
    </Flex>
  );
}
