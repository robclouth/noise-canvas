import { Stack, Text } from "@mantine/core";
import { useEffect, useState } from "react";
import { penState } from "../../lib/pen-state";
import { ParameterControl } from "../controls/parameter-control";
import { SourcePositionControl } from "../controls/source-position-control";
import { Section } from "../section";

function TabletDebug() {
  const [display, setDisplay] = useState({ pressure: 0, tiltX: 0, tiltY: 0 });

  useEffect(() => {
    let raf: number;
    const poll = (): void => {
      setDisplay((prev) => {
        if (prev.pressure === penState.pressure && prev.tiltX === penState.tiltX && prev.tiltY === penState.tiltY) {
          return prev;
        }
        return { pressure: penState.pressure, tiltX: penState.tiltX, tiltY: penState.tiltY };
      });
      raf = requestAnimationFrame(poll);
    };
    raf = requestAnimationFrame(poll);
    return () => cancelAnimationFrame(raf);
  }, []);

  return (
    <Text size="xs" c="dimmed" style={{ fontFamily: "monospace" }}>
      P: {display.pressure.toFixed(3)} TX: {display.tiltX.toFixed(1)} TY: {display.tiltY.toFixed(1)}
    </Text>
  );
}

export function ControlsPanel() {
  return (
    <Stack h="100%" w="100%" p="xs" gap="xs">
      <Section label="Tablet">
        <TabletDebug />
      </Section>
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
