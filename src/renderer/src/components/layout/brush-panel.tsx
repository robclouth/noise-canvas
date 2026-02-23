import { Divider, SimpleGrid, Stack } from "@mantine/core";
import { NUM_MODULATORS } from "@renderer/lib/constants";
import { ParameterKey } from "@renderer/store/types";
import { EnvelopeControl } from "../controls/envelope-control";
import { ParameterControl } from "../controls/parameter-control";
import { PresetSelector } from "../controls/preset-selector";
import { Slots } from "../controls/slots";
import { Steps } from "../controls/steps";
import { EffectsList } from "../effects-list";
import { ModulatorView } from "../modulator-view";
import { Section } from "../section";

// Pure envelope parameters (delay/attack/sustain/release for time and pitch)
const ENVELOPE_PARAMS: ParameterKey[] = [
  "brushIntensity",
  "brushEnvelopeDelayTime",
  "brushEnvelopeAttackTime",
  "brushEnvelopeSustainTime",
  "brushEnvelopeReleaseTime",
  "brushEnvelopeDelayPitch",
  "brushEnvelopeAttackPitch",
  "brushEnvelopeSustainPitch",
  "brushEnvelopeReleasePitch",
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
  return (
    <Stack gap="xs">
      <Stack p="xs" gap="xs">
        <Slots />
        <PresetSelector />
        <Divider style={{ flex: 1 }} color="dark.4" />
        <Steps />
        <Section label="Envelope" parameterKeys={ENVELOPE_PARAMS}>
          <EnvelopeControl />
        </Section>
        <Section label="Options" parameterKeys={OPTIONS_PARAMS}>
          <SimpleGrid cols={2} spacing="xs" verticalSpacing={0}>
            <ParameterControl paramKey="blendMode" />
            <ParameterControl paramKey="brushPan" />
            <ParameterControl paramKey="brushIterations" />
            <ParameterControl paramKey="brushWrapMode" />
            <ParameterControl paramKey="algorithm" />
            <ParameterControl paramKey="sourceDataMode" />
            <ParameterControl paramKey="accumulate" />
          </SimpleGrid>
        </Section>
        <Section label="Effects" parameterKeys={ALL_EFFECT_PARAMS} includeEffectOrder>
          <EffectsList />
        </Section>
        <Section label="Modulators" parameterKeys={MODULATOR_PARAMS}>
          <ModulatorView />
        </Section>
      </Stack>
    </Stack>
  );
}
