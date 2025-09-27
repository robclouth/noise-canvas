import { useStore } from "@/store";
import { Stack } from "@mantine/core";
import { brushes } from "@renderer/brushes";
import { ParameterControl } from "../controls/parameter-control";
import { ModulatorView } from "../modulator-view";
import { Section } from "../section";

export function BrushPanel() {
  const brushType = useStore((state) => state.brushType.value);
  const brushSizeLockedToGrid = useStore((state) => state.brushSizeLockedToGrid.value);

  const brush = brushes[brushType];
  return (
    <Stack w={300} miw={300} p="xs">
      <Section label="Size">
        <ParameterControl paramKey="brushWidthBeats" disabled={brushSizeLockedToGrid} />
        <ParameterControl paramKey="brushHeightSemis" disabled={brushSizeLockedToGrid} />
        <ParameterControl paramKey="brushSizeLockedToGrid" />
      </Section>
      <Section label="Output">
        <ParameterControl paramKey="brushIntensity" />
        <ParameterControl paramKey="brushIterations" />
        <ParameterControl paramKey="brushPan" />
        <ParameterControl paramKey="blendMode" />
      </Section>
      <Section label="Feather">
        <ParameterControl paramKey="featherTime" />
        <ParameterControl paramKey="featherPitch" />
      </Section>
      <Section label="Offset">
        <ParameterControl paramKey="sourceOffsetBeats" />
        <ParameterControl paramKey="sourceOffsetSemis" />
        <ParameterControl paramKey="sourceOffsetLock" />
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
