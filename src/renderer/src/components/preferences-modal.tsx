import { Box, Stack, Text } from "@mantine/core";
import { openContextModal } from "@mantine/modals";
import { gpuMemoryInfo } from "@renderer/lib/gpu-budget";

// eslint-disable-next-line react-refresh/only-export-components
export function openPreferencesModal(): void {
  openContextModal({ modal: "preferences", title: "Preferences", size: "md", innerProps: {} });
}

function graphicsMemoryLabel(): string | null {
  const { bytes } = gpuMemoryInfo();
  if (bytes <= 0) return null;
  const gb = bytes / (1024 * 1024 * 1024);
  return gb >= 10 ? `${Math.round(gb)} GB` : `${gb.toFixed(1)} GB`;
}

export const PreferencesModal = () => {
  const memory = graphicsMemoryLabel();

  return (
    <Stack gap="md">
      <Box>
        <Text size="sm" fw={600} mb={4}>
          Graphics
        </Text>
        {memory && (
          <Text size="xs" c="dimmed">
            This computer has {memory} of graphics memory.
          </Text>
        )}
      </Box>
    </Stack>
  );
};
