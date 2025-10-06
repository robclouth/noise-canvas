import { useStore } from "@/store";
import { Stack } from "@mantine/core";
import { ParameterControl } from "../controls/parameter-control";
import { PresetSelector } from "../controls/preset-selector";
import { SourcePositionControl } from "../controls/source-position-control";
import { EffectsList } from "../effects-list";
import { ModulatorView } from "../modulator-view";
import { Section } from "../section";

export function BrushPanel() {
  const brushSizeLockedToGrid = useStore((state) => state.brushSizeLockedToGrid.value);

  return (
    <Stack p="xs">
      <Section label="Preset">
        <PresetSelector />
      </Section>
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
        <ParameterControl paramKey="brushFeatherTime" />
        <ParameterControl paramKey="brushFeatherPitch" />
        <ParameterControl paramKey="brushFeatherSlopeTime" />
        <ParameterControl paramKey="brushFeatherSlopePitch" />
      </Section>
      <Section label="Source Position">
        <SourcePositionControl />
      </Section>

      <Section label="Effects">
        <EffectsList />
      </Section>

      <Section label="Modulators">
        <ModulatorView />
      </Section>
    </Stack>
  );
}
