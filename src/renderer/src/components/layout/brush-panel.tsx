import { SimpleGrid, Stack } from "@mantine/core";
import { NUM_MACROS, NUM_MODULATORS } from "@renderer/lib/constants";
import { PANEL_COLUMN_SPACING } from "@renderer/lib/ui-density";
import { selectParameter, useStore } from "@renderer/store";
import { ParameterKey } from "@renderer/store/types";
import { EnvelopeControl } from "../controls/envelope-control";
import { MacroControls } from "../controls/macro-controls";
import { ParameterControl } from "../controls/parameter-control";
import { Steps } from "../controls/steps";
import { EffectsList } from "../effects-list";
import { ModulatorView } from "../modulator-view";
import { Section } from "../section";

// Envelope parameters: size/curve/skew per axis plus intensity
const ENVELOPE_PARAMS: ParameterKey[] = [
  "brushIntensity",
  "brushAnchorMode",
  "brushSizeTime",
  "brushCurveTime",
  "brushSkewTime",
  "brushSizePitch",
  "brushCurvePitch",
  "brushSkewPitch",
];

// Options parameters (split from envelope)
const OPTIONS_PARAMS: ParameterKey[] = [
  "blendMode",
  "brushPan",
  "brushIterations",
  "brushWrapMode",
  "algorithm",
  "sourceDataMode",
  "accumulate",
];

const MODULATOR_PARAMS = Array.from({ length: NUM_MODULATORS }).flatMap((_, i) => {
  const idx = i + 1;
  return [
    `modulator${idx}Mode`,
    `modulator${idx}PatternShape`,
    `modulator${idx}PatternRateBeats`,
    `modulator${idx}PatternRateSemis`,
    `modulator${idx}Rotation`,
    `modulator${idx}PhaseMode`,
    `modulator${idx}Strength`,
    `modulator${idx}EnvelopeMinDb`,
    `modulator${idx}EnvelopeMaxDb`,
  ] as ParameterKey[];
});

const MACRO_PARAMS = Array.from({ length: NUM_MACROS }, (_, i) => `macro${i + 1}Value` as ParameterKey);

// All effect parameters combined for the Effects section randomizer
const ALL_EFFECT_PARAMS: ParameterKey[] = [
  "dynamicsThresholdDb",
  "dynamicsUpperRatio",
  "dynamicsLowerRatio",
  "dynamicsKnee",
  "dynamicsGainDb",
  "transformShiftBeats",
  "transformShiftSemis",
  "transformScaleTime",
  "transformScalePitch",
  "transformRotation",
  "transformEdgeMode",
  "overtonesCount",
  "overtonesScale",
  "overtonesDecay",
  "overtonesShape",
  "blurAmountTime",
  "blurAmountPitch",
  "blurNoiseTime",
  "blurNoisePitch",
  "blurSamplesX",
  "blurSamplesY",
  "blurEdgeMode",
  "blurOrigin",
  "synthesizeBrushType",
];

export function BrushPanel() {
  const sourcePositionMode = useStore(selectParameter("sourcePositionMode"));
  const offsetsDisabled = sourcePositionMode === "follow";
  return (
    <Stack gap="xs">
      <Stack p="xs" gap="xs">
        <Section
          label="Macros"
          description="Four renamable knobs per brush. Assign one to any set of modulatable parameters from their label menus and move them all together."
          parameterKeys={MACRO_PARAMS}
        >
          <MacroControls />
        </Section>
        <Steps />
        <Section
          label="Source"
          description="Where the brush reads audio from. By default it reads the file you are painting on; point it at another open file to paint one sound onto another."
        >
          <SimpleGrid cols={2} spacing={PANEL_COLUMN_SPACING} verticalSpacing={0}>
            <ParameterControl paramKey="sourceFile" />
            <ParameterControl paramKey="sourcePositionMode" />
            <ParameterControl paramKey="sourceTimeOffset" disabled={offsetsDisabled} />
            <ParameterControl paramKey="sourcePitchOffset" disabled={offsetsDisabled} />
            <ParameterControl paramKey="sourceDataMode" />
          </SimpleGrid>
        </Section>
        <Section
          label="Envelope"
          description="The size and shape of the brush footprint — how far a stroke reaches in time and pitch, and how the effect fades towards its edges."
          parameterKeys={ENVELOPE_PARAMS}
        >
          <EnvelopeControl />
        </Section>
        <Section
          label="Options"
          description="How the processed result is merged back in: blend mode, stereo placement, feedback iterations, edge wrapping, and the resynthesis algorithm."
          parameterKeys={OPTIONS_PARAMS}
        >
          <SimpleGrid cols={2} spacing={PANEL_COLUMN_SPACING} verticalSpacing={0}>
            <ParameterControl paramKey="blendMode" />
            <ParameterControl paramKey="brushPan" />
            <ParameterControl paramKey="brushIterations" />
            <ParameterControl paramKey="brushWrapMode" />
            <ParameterControl paramKey="algorithm" />
            <ParameterControl paramKey="accumulate" />
          </SimpleGrid>
        </Section>
        <Section
          label="Effects"
          description="What each stroke actually does to the sound. Effects run top to bottom and can be reordered, disabled, or stacked several deep."
          parameterKeys={ALL_EFFECT_PARAMS}
          includeEffectOrder
        >
          <EffectsList />
        </Section>
        <Section
          label="Modulators"
          description="Three sources that vary parameters across time and pitch as you paint. Set one up here, then dial in how much it affects a parameter from that parameter's label menu."
          parameterKeys={MODULATOR_PARAMS}
        >
          <ModulatorView />
        </Section>
      </Stack>
    </Stack>
  );
}
