import { Stack, Text } from "@mantine/core";
import { ParameterControl } from "../controls/parameter-control";
import { SourcePositionControl } from "../controls/source-position-control";
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
        <ParameterControl paramKey="gridSizeSemis" />
      </Section>
      <Section label="Display">
        <ParameterControl paramKey="displayMinDb" />
        <ParameterControl paramKey="displayMaxDb" />
      </Section>
      <Section label="Source Position">
        <SourcePositionControl />
      </Section>

      <Section label="Scale">
        <ParameterControl paramKey="scaleTonic" />
        <ParameterControl paramKey="scaleType" />
      </Section>
      <Section label="Output">
        <ParameterControl paramKey="magnitudeLimit" />
        <ParameterControl paramKey="normalize" />
      </Section>
    </Stack>
  );
}
