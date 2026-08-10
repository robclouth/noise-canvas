import { Button, Center, Group, Stack, Text } from "@mantine/core";
import { FileAudio } from "lucide-react";
import { MOD_KEY } from "../lib/constants";
import { ipcSend } from "../lib/ipc";

const STEPS: { title: string; body: string }[] = [
  {
    title: "Open a sound",
    body: "Drag an audio file in, or use the button above. It gets analyzed into a spectrogram: time across, pitch up, brightness for loudness.",
  },
  {
    title: "Pick a brush",
    body: "Use New brush in the Brushes panel on the right to load one from the factory library — Echo, Reverb, Smudge, Pixel Sort and more.",
  },
  {
    title: "Paint on it",
    body: `Drag across the spectrogram to apply the brush. Press space to hear the result, and ${MOD_KEY}+Z to undo anything you don't like.`,
  },
];

export function EmptyState() {
  const handleOpenClick = () => {
    ipcSend("trigger-open-file");
  };

  return (
    <Center flex={1} w="100%" p="md">
      <Stack align="center" gap="lg" maw={560}>
        <Stack align="center" gap="md">
          <FileAudio size={48} strokeWidth={1.5} color="var(--mantine-color-dimmed)" />
          <Stack align="center" gap={4}>
            <Text size="lg" fw={500}>
              No audio file open
            </Text>
            <Text size="sm" c="dimmed">
              Drag and drop an audio file here, or use the button below
            </Text>
          </Stack>
          <Button variant="light" color="orange" onClick={handleOpenClick}>
            Open Audio File
          </Button>
        </Stack>

        <Stack gap="xs" w="100%">
          {STEPS.map((step, index) => (
            <Group key={step.title} gap="sm" wrap="nowrap" align="flex-start">
              <Text size="sm" fw={700} c="orange.5" w={16} ta="right" style={{ flexShrink: 0 }}>
                {index + 1}
              </Text>
              <Stack gap={0}>
                <Text size="sm" fw={500}>
                  {step.title}
                </Text>
                <Text size="xs" c="dimmed" lh={1.4}>
                  {step.body}
                </Text>
              </Stack>
            </Group>
          ))}
        </Stack>

        <Text size="xs" c="dimmed" ta="center">
          Every control has a tooltip — hover anything you don&apos;t recognise.
        </Text>
      </Stack>
    </Center>
  );
}
