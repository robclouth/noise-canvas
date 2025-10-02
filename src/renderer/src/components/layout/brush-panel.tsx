import { useStore } from "@/store";
import { Stack } from "@mantine/core";
import { BlurBrush } from "../brush-views/blur-brush";
import { GainBrush } from "../brush-views/gain-brush";
import { HarmonicsBrush } from "../brush-views/harmonics-brush";
import { SharpenBrush } from "../brush-views/sharpen-brush";
import { SynthesizeBrush } from "../brush-views/synthesize-brush";
import { TransformBrush } from "../brush-views/transform-brush";
import { ParameterControl } from "../controls/parameter-control";
import { ModulatorView } from "../modulator-view";
import { Section } from "../section";

const BRUSH_VIEWS = {
  gain: <GainBrush />,
  transform: <TransformBrush />,
  harmonics: <HarmonicsBrush />,
  blur: <BlurBrush />,
  sharpen: <SharpenBrush />,
  synthesize: <SynthesizeBrush />,
  restore: <></>,
};

export function BrushPanel() {
  const brushTypeParameter = useStore((state) => state.brushType);
  const brushSizeLockedToGridParameter = useStore((state) => state.brushSizeLockedToGrid);
  const brushWidthBeatsParameter = useStore((state) => state.brushWidthBeats);
  const brushHeightSemisParameter = useStore((state) => state.brushHeightSemis);
  const brushIntensityParameter = useStore((state) => state.brushIntensity);
  const brushIterationsParameter = useStore((state) => state.brushIterations);
  const brushPanParameter = useStore((state) => state.brushPan);
  const brushFeatherTimeParameter = useStore((state) => state.brushFeatherTime);
  const brushFeatherPitchParameter = useStore((state) => state.brushFeatherPitch);
  const brushFeatherSlopeTimeParameter = useStore((state) => state.brushFeatherSlopeTime);
  const brushFeatherSlopePitchParameter = useStore((state) => state.brushFeatherSlopePitch);
  const sourceOffsetBeatsParameter = useStore((state) => state.sourceOffsetBeats);
  const sourceOffsetSemisParameter = useStore((state) => state.sourceOffsetSemis);
  const sourceOffsetLockParameter = useStore((state) => state.sourceOffsetLock);
  const blendModeParameterParameter = useStore((state) => state.blendMode);

  return (
    <Stack p="xs">
      <Section label="Size">
        <ParameterControl parameter={brushWidthBeatsParameter} disabled={brushSizeLockedToGridParameter.value} />
        <ParameterControl parameter={brushHeightSemisParameter} disabled={brushSizeLockedToGridParameter.value} />
        <ParameterControl parameter={brushSizeLockedToGridParameter} />
      </Section>
      <Section label="Output">
        <ParameterControl parameter={brushIntensityParameter} />
        <ParameterControl parameter={brushIterationsParameter} />
        <ParameterControl parameter={brushPanParameter} />
        <ParameterControl parameter={blendModeParameterParameter} />
      </Section>
      <Section label="Feather">
        <ParameterControl parameter={brushFeatherTimeParameter} />
        <ParameterControl parameter={brushFeatherPitchParameter} />
        <ParameterControl parameter={brushFeatherSlopeTimeParameter} />
        <ParameterControl parameter={brushFeatherSlopePitchParameter} />
      </Section>
      <Section label="Offset">
        <ParameterControl parameter={sourceOffsetBeatsParameter} />
        <ParameterControl parameter={sourceOffsetSemisParameter} />
        <ParameterControl parameter={sourceOffsetLockParameter} />
      </Section>
      <Section label="Brush">
        <ParameterControl parameter={brushTypeParameter} />
        {BRUSH_VIEWS[brushTypeParameter.value] ? BRUSH_VIEWS[brushTypeParameter.value] : null}
      </Section>
      <Section label="Modulators">
        <ModulatorView />
      </Section>
    </Stack>
  );
}
