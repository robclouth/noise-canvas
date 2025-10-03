import { useStore } from "@/store";
import { Stack } from "@mantine/core";
import { useEffect } from "react";
import { ParameterControl } from "../controls/parameter-control";
import { Section } from "../section";

export function ControlsPanel() {
  useEffect(() => {
    const unsubscribe = useStore.subscribe(
      (state) => ({
        brushSizeLockedToGrid: state.brushSizeLockedToGrid.value,
        gridSizeBeats: state.gridSizeBeats.value,
        gridSizeSemis: state.gridSizeSemis.value,
        setBrushWidthBeats: state.brushWidthBeats.setValue,
        setBrushHeightSemis: state.brushHeightSemis.setValue,
      }),
      ({ brushSizeLockedToGrid, gridSizeBeats, gridSizeSemis, setBrushWidthBeats, setBrushHeightSemis }) => {
        if (brushSizeLockedToGrid) {
          setBrushWidthBeats(gridSizeBeats);
          setBrushHeightSemis(gridSizeSemis);
        }
      },
    );
    return () => unsubscribe();
  }, []);

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
