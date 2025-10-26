import { useStore } from "@/store";
import { Stack } from "@mantine/core";
import { ParameterControl } from "../controls/parameter-control";
import { PresetSelector } from "../controls/preset-selector";
import { QuickSlots } from "../controls/quick-slots";
import { EffectsList } from "../effects-list";
import { ModulatorView } from "../modulator-view";
import { Section } from "../section";

export function BrushPanel() {
  const brushSizeLockedToGrid = useStore((state) => state.brushSizeLockedToGrid);

  return (
    <Stack p="xs" gap="xs">
      <PresetSelector />
      <QuickSlots />
      <Section label="Brush">
        <ParameterControl paramKey="brushWidthBeats" disabled={brushSizeLockedToGrid} />
        <ParameterControl paramKey="brushHeightSemis" disabled={brushSizeLockedToGrid} />
        <ParameterControl paramKey="brushIntensity" />
        <ParameterControl paramKey="blendMode" />
        <ParameterControl paramKey="brushPan" />
        <ParameterControl paramKey="brushIterations" />
        <ParameterControl paramKey="brushWrapMode" />
        <ParameterControl paramKey="algorithm" />
        <ParameterControl paramKey="brushFeatherTime" />
        <ParameterControl paramKey="brushFeatherPitch" />
        <ParameterControl paramKey="brushFeatherSlopeTime" />
        <ParameterControl paramKey="brushFeatherSlopePitch" />
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
