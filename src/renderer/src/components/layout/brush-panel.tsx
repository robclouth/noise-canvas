import { Box, SimpleGrid, Stack } from "@mantine/core";
import {
  ALL_EFFECT_PARAMS,
  ENVELOPE_PARAMS,
  MACRO_PARAMS,
  MODULATOR_PARAMS,
  OPTIONS_PARAMS,
} from "@renderer/lib/brush-sections";
import { PANEL_COLUMN_SPACING, SECTION_GAP } from "@renderer/lib/ui-density";
import { selectParameter, useStore } from "@renderer/store";
import { EnvelopeControl } from "../controls/envelope-control";
import { MacroControls } from "../controls/macro-controls";
import { ParameterControl } from "../controls/parameter-control";
import { StepScope, Steps } from "../controls/steps";
import { EffectsList } from "../effects-list";
import { ModulatorView } from "../modulator-view";
import { Section } from "../section";

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
