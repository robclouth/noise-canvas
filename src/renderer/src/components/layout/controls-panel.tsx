import { useStore } from "@/store";
import { Stack } from "@mantine/core";
import { useEffect } from "react";
import { ParameterControl } from "../controls/parameter-control";
import { Section } from "../section";

export function ControlsPanel() {
  const gridSizeBeatsParameter = useStore((state) => state.gridSizeBeats);
  const gridSizeSemisParameter = useStore((state) => state.gridSizeSemis);
  const scaleTonicParameter = useStore((state) => state.scaleTonic);
  const scaleTypeParameter = useStore((state) => state.scaleType);
  const normalizeParameter = useStore((state) => state.normalize);
  const brushSizeLockedToGrid = useStore((state) => state.brushSizeLockedToGrid.value);
  const bandsPerOctaveParameter = useStore((state) => state.bandsPerOctave);

  const setBrushWidth = useStore((state) => state.brushWidthBeats.setValue);
  const setBrushHeight = useStore((state) => state.brushHeightSemis.setValue);

  useEffect(() => {
    if (brushSizeLockedToGrid) {
      setBrushWidth(gridSizeBeatsParameter.value);
      setBrushHeight(gridSizeSemisParameter.value);
    }
  }, [
    brushSizeLockedToGrid,
    gridSizeBeatsParameter.value,
    gridSizeSemisParameter.value,
    setBrushWidth,
    setBrushHeight,
  ]);

  return (
    <Stack h="100%" w="100%" p="xs">
      <Section label="Analysis">
        <ParameterControl parameter={bandsPerOctaveParameter} />
      </Section>
      <Section label="Grid">
        <ParameterControl parameter={gridSizeBeatsParameter} />
        <ParameterControl parameter={gridSizeSemisParameter} />
      </Section>
      <Section label="Scale">
        <ParameterControl parameter={scaleTonicParameter} />
        <ParameterControl parameter={scaleTypeParameter} />
      </Section>
      <Section label="Output">
        <ParameterControl parameter={normalizeParameter} />
      </Section>
    </Stack>
  );
}
