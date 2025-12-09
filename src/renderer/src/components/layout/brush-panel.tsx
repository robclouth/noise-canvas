import { Group, SimpleGrid, Stack } from "@mantine/core";
import { EnvelopeControl } from "../controls/envelope-control";
import { ParameterControl } from "../controls/parameter-control";
import { PresetSelector } from "../controls/preset-selector";
import { QuickSlots } from "../controls/quick-slots";
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
      <Group wrap="nowrap" align="start">
        <Stack p="xs" gap="xs">
          <Section label="Envelope">
            <EnvelopeControl />
            <SimpleGrid cols={2} spacing="xs" verticalSpacing={0}>
              <ParameterControl paramKey="blendMode" />
              <ParameterControl paramKey="brushPan" />
              <ParameterControl paramKey="brushIterations" />
              <ParameterControl paramKey="brushWrapMode" />
              <ParameterControl paramKey="algorithm" />
              <ParameterControl paramKey="sourceDataMode" />
            </SimpleGrid>
          </Section>
          <Section label="Modulators">
            <ModulatorView />
          </Section>
        </Stack>
        <Stack p="xs" gap="xs">
          <Section label="Effects">
            <EffectsList />
          </Section>
        </Stack>
      </Group>
    </Stack>
  );
}
