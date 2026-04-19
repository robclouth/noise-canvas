import { Stack, Text } from "@mantine/core";
import { ParameterControl } from "../controls/parameter-control";
import { Section } from "../section";

export function ControlsPanel() {
  return (
    <Stack h="100%" w="100%" p="xs" gap="xs">
      <Section label="Analysis">
        <Text size="xs" c="dimmed" fs="italic">
          Applies to newly loaded files only
        </Text>
        <ParameterControl paramKey="bandsPerOctave" />
      </Section>
      <Section label="Grid">
        <ParameterControl paramKey="gridSizeBeats" />
        <ParameterControl paramKey="gridSwing" />
        <ParameterControl paramKey="gridSizeSemis" />
        <ParameterControl paramKey="snapTime" />
        <ParameterControl paramKey="snapPitch" />
      </Section>
      <Section label="Display">
        <ParameterControl paramKey="displayMinDb" />
        <ParameterControl paramKey="displayMaxDb" />
      </Section>

      <Section label="Scale">
        <ParameterControl paramKey="scaleTonic" />
        <ParameterControl paramKey="scaleType" />
      </Section>
      <Section label="Output">
        <ParameterControl paramKey="magnitudeLimit" />
        <ParameterControl paramKey="normalize" />
      </Section>
      <Section label="Link">
        <ParameterControl paramKey="linkLatencyMs" />
      </Section>
    </Stack>
  );
}
