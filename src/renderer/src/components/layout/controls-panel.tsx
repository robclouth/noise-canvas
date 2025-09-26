import { useStore } from "@/store";
import { Stack } from "@mantine/core";
import { useEffect } from "react";
import { ParameterControl } from "../controls/parameter-control";
import { Section } from "../section";

export function ControlsPanel() {
  const brushSizeLockedToGrid = useStore((state) => state.brushSizeLockedToGrid.value);
  const gridSize = useStore((state) => state.gridSize.value);
  const gridSizeY = useStore((state) => state.gridSizeY.value);
  const setBrushWidth = useStore((state) => state.brushWidth.setValue);
  const setBrushHeight = useStore((state) => state.brushHeight.setValue);

  useEffect(() => {
    if (brushSizeLockedToGrid) {
      setBrushWidth(gridSize);
      setBrushHeight(gridSizeY);
    }
  }, [brushSizeLockedToGrid, gridSize, gridSizeY, setBrushWidth, setBrushHeight]);

  return (
    <Stack w={300} miw={300} p="xs">
      <Section label="Analysis">
        <ParameterControl paramKey="bandsPerOctave" />
      </Section>
      <Section label="Grid">
        <ParameterControl paramKey="gridSize" />
        <ParameterControl paramKey="gridSizeY" />
      </Section>
      <Section label="Scale">
        <ParameterControl paramKey="scaleTonic" />
        <ParameterControl paramKey="scaleType" />
      </Section>
      <Section label="Output">
        <ParameterControl paramKey="normalize" />
      </Section>
    </Stack>
  );
}
