import { Box, SimpleGrid, Stack } from "@mantine/core";
import { NUM_MACROS, NUM_MODULATORS } from "@renderer/lib/constants";
import { PANEL_COLUMN_SPACING, SECTION_GAP } from "@renderer/lib/ui-density";
import { getAllEffectParameterKeys } from "@renderer/parameters";
import { selectParameter, useStore } from "@renderer/store";
import { ParameterKey } from "@renderer/store/types";
import { EnvelopeControl } from "../controls/envelope-control";
import { MacroControls } from "../controls/macro-controls";
import { ParameterControl } from "../controls/parameter-control";
import { StepScope, Steps } from "../controls/steps";
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

// Every effect's parameters, for the Effects section header's reset, randomise
// and preset actions. Derived rather than listed, so a new effect is covered
// the moment its parameters declare an effectType.
const ALL_EFFECT_PARAMS: ParameterKey[] = getAllEffectParameterKeys();

export function BrushPanel() {
  const sourcePositionMode = useStore(selectParameter("sourcePositionMode"));
  const offsetsDisabled = sourcePositionMode === "follow";
  return (
    <Stack gap="xs">
      <Stack p="xs" gap={SECTION_GAP}>
        <Section label="Macros" parameterKeys={MACRO_PARAMS} anchor="section-macros">
          <MacroControls />
        </Section>
        <Box mt={6}>
          <Steps />
        </Box>
        <StepScope>
          <Section label="Source" anchor="section-source">
            <SimpleGrid cols={2} spacing={PANEL_COLUMN_SPACING} verticalSpacing={0}>
              <ParameterControl paramKey="sourceFile" />
              <ParameterControl paramKey="sourcePositionMode" />
              <ParameterControl paramKey="sourceTimeOffset" disabled={offsetsDisabled} />
              <ParameterControl paramKey="sourcePitchOffset" disabled={offsetsDisabled} />
              <ParameterControl paramKey="sourceDataMode" />
            </SimpleGrid>
          </Section>
          <Section label="Envelope" parameterKeys={ENVELOPE_PARAMS} anchor="section-envelope">
            <EnvelopeControl />
          </Section>
          <Section label="Options" parameterKeys={OPTIONS_PARAMS} anchor="section-options">
            <SimpleGrid cols={2} spacing={PANEL_COLUMN_SPACING} verticalSpacing={0}>
              <ParameterControl paramKey="blendMode" />
              <ParameterControl paramKey="brushPan" />
              <ParameterControl paramKey="brushIterations" />
              <ParameterControl paramKey="brushWrapMode" />
              <ParameterControl paramKey="algorithm" />
              <ParameterControl paramKey="accumulate" />
            </SimpleGrid>
          </Section>
          <Section label="Effects" parameterKeys={ALL_EFFECT_PARAMS} includeEffectOrder anchor="section-effects">
            <EffectsList />
          </Section>
          <Section label="Modulators" parameterKeys={MODULATOR_PARAMS} anchor="section-modulators">
            <ModulatorView />
          </Section>
        </StepScope>
      </Stack>
    </Stack>
  );
}
