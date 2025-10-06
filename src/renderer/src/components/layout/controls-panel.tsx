import { useStore } from "@/store";
import { Stack, Text } from "@mantine/core";
import { useEffect } from "react";
import { ParameterControl } from "../controls/parameter-control";
import { Section } from "../section";

export function ControlsPanel() {
  const brushSizeLockedToGrid = useStore((state) => state.brushSizeLockedToGrid.value);
  const gridSizeBeats = useStore((state) => state.gridSizeBeats.value);
  const gridSizeSemis = useStore((state) => state.gridSizeSemis.value);

  useEffect(() => {
    if (brushSizeLockedToGrid) {
      const state = useStore.getState();
      state.brushWidthBeats.setValue(gridSizeBeats);
      state.brushHeightSemis.setValue(gridSizeSemis);
    }
  }, [brushSizeLockedToGrid, gridSizeBeats, gridSizeSemis]);

  return (
    <Stack h="100%" w="100%" p="xs">
      <Section label="Analysis">
        <Text size="xs" c="dimmed" fs="italic" mb="xs">
          Applies to newly loaded files only
        </Text>
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
