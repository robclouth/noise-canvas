import { Button, Center, Stack, Text } from "@mantine/core";
import { FileAudio } from "lucide-react";
import { ipcSend } from "../lib/ipc";

export function EmptyState() {
  const handleOpenClick = () => {
    ipcSend("trigger-open-file");
  };

  return (
    <Center flex={1} w="100%">
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
    </Center>
  );
}
