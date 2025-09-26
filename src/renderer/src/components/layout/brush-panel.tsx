import { brushes } from "@/components/brushes";
import { useStore } from "@/store";
import { Stack } from "@mantine/core";
import { ParameterControl } from "../controls/parameter-control";
import { ModulatorView } from "../modulator-view";
import { Section } from "../section";

export function BrushPanel() {
  const brushType = useStore((state) => state.brushType.value);
  const brushSizeLockedToGrid = useStore((state) => state.brushSizeLockedToGrid.value);

  // useEffect(() => {
  //   if (brushSizeLockedToGrid) {
  //     setBrushWidth(gridSize);
  //     setBrushHeight(gridSizeY);
  //   }
  // }, [brushSizeLockedToGrid, gridSize, gridSizeY, setBrushWidth, setBrushHeight]);

  const brush = brushes[brushType];
  return (
    <Stack w={300} miw={300} p="xs">
      <Section label="Size">
        <ParameterControl paramKey="brushWidth" disabled={brushSizeLockedToGrid} />
        <ParameterControl paramKey="brushHeight" disabled={brushSizeLockedToGrid} />
        <ParameterControl paramKey="brushSizeLockedToGrid" />
      </Section>
      <Section label="Output">
        <ParameterControl paramKey="brushIntensity" />
        <ParameterControl paramKey="pan" />
        <ParameterControl paramKey="blendMode" />
      </Section>
      <Section label="Feather">
        <ParameterControl paramKey="featherX" />
        <ParameterControl paramKey="featherY" />
      </Section>
      <Section label="Offset">
        <ParameterControl paramKey="offsetX" />
        <ParameterControl paramKey="offsetY" />
        <ParameterControl paramKey="offsetLock" />
      </Section>
      <Section label="Brush">
        <ParameterControl paramKey="brushType" />
        {brush ? brush.parameters.map((param) => <ParameterControl key={param} paramKey={param} />) : null}
      </Section>
      <Section label="Modulator">
        <ModulatorView />
      </Section>
    </Stack>
  );
}
