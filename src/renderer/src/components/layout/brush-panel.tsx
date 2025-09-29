import { useStore } from "@/store";
import { Stack } from "@mantine/core";
import { BlurBrush } from "../brush-views/blur-brush";
import { GainBrush } from "../brush-views/gain-brush";
import { SharpenBrush } from "../brush-views/sharpen-brush";
import { TransformBrush } from "../brush-views/transform-brush";
import { ParameterControl } from "../controls/parameter-control";
import { ModulatorView } from "../modulator-view";
import { Section } from "../section";

const BRUSH_VIEWS = {
  gain: <GainBrush />,
  transform: <TransformBrush />,
  blur: <BlurBrush />,
  sharpen: <SharpenBrush />,
};

export function BrushPanel() {
  const brushType = useStore((state) => state.brushType.value);
  const brushSizeLockedToGrid = useStore((state) => state.brushSizeLockedToGrid.value);

  return (
    <Stack p="xs">
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
      <Section label="Offset">
        <ParameterControl paramKey="sourceOffsetBeats" />
        <ParameterControl paramKey="sourceOffsetSemis" />
        <ParameterControl paramKey="sourceOffsetLock" />
      </Section>
      <Section label="Brush">
        <ParameterControl paramKey="brushType" />
        {BRUSH_VIEWS[brushType] ? BRUSH_VIEWS[brushType] : null}
      </Section>
      <Section label="Modulation">
        <ModulatorView />
      </Section>
    </Stack>
  );
}
