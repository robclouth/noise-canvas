import { useStore } from "@/store";
import { Stack } from "@mantine/core";
import { useEffect } from "react";
import { ParameterControl } from "../controls/parameter-control";
import { Section } from "../section";

export function ControlsPanel() {
  const brushSizeLockedToGrid = useStore((state) => state.brushSizeLockedToGrid.value);
  const gridSize = useStore((state) => state.gridSizeBeats.value);
  const gridSizeY = useStore((state) => state.gridSizeSemis.value);
  const setBrushWidth = useStore((state) => state.brushWidthBeats.setValue);
  const setBrushHeight = useStore((state) => state.brushHeightSemis.setValue);

  useEffect(() => {
    if (brushSizeLockedToGrid) {
      setBrushWidth(gridSize);
      setBrushHeight(gridSizeY);
    }
  }, [brushSizeLockedToGrid, gridSize, gridSizeY, setBrushWidth, setBrushHeight]);

  return (
    <Stack h="100%" w="100%" p="xs">
      <Section label="Analysis">
        <ParameterControl paramKey="bandsPerOctave" />
      </Section>
      <Section label="Grid">
        <ParameterControl paramKey="gridSizeBeats" />
        <ParameterControl paramKey="gridSizeSemis" />
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
