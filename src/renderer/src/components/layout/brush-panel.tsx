import { SimpleGrid, Stack } from "@mantine/core";
import { EnvelopeControl } from "../controls/envelope-control";
import { ParameterControl } from "../controls/parameter-control";
import { PresetSelector } from "../controls/preset-selector";
import { QuickSlots } from "../controls/quick-slots";
import { Steps } from "../controls/steps";
import { EffectsList } from "../effects-list";
import { ModulatorView } from "../modulator-view";
import { Section } from "../section";

export function BrushPanel() {
  return (
    <Stack gap="xs">
      <Stack p="xs" gap="xs">
        <PresetSelector />
        <QuickSlots />
      </Stack>
      <Steps />
      <Stack px="xs" gap="xs">
        <Section label="Envelope">
          <Stack gap="xs">
            <EnvelopeControl />
            <SimpleGrid cols={2} spacing="xs" verticalSpacing={0}>
              <ParameterControl paramKey="blendMode" />
              <ParameterControl paramKey="brushPan" />
              <ParameterControl paramKey="brushIterations" />
              <ParameterControl paramKey="brushWrapMode" />
              <ParameterControl paramKey="algorithm" />
              <ParameterControl paramKey="sourceDataMode" />
            </SimpleGrid>
          </Stack>
        </Section>
        <Section label="Effects">
          <EffectsList />
        </Section>
        <Section label="Modulators">
          <ModulatorView />
        </Section>
      </Stack>
    </Stack>
  );
}
