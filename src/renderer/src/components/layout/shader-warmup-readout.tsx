import { Box, Group, Text } from "@mantine/core";
import { getShaderWarmupProgress, subscribeShaderWarmupProgress } from "@renderer/lib/shader-warmup-progress";
import { useSyncExternalStore } from "react";
import { Tooltip } from "../tooltip";

/**
 * How far the effect shaders have got. Shown only while they are still being
 * prepared, so the bar is absent for all of a normal session.
 */
export function ShaderWarmupReadout() {
  const { done, total } = useSyncExternalStore(
    subscribeShaderWarmupProgress,
    getShaderWarmupProgress,
    getShaderWarmupProgress,
  );

  if (total === 0) return null;

  const percent = Math.round((done / total) * 100);

  return (
    <Tooltip label="Prepares the effects for painting, while the rest of the app stays usable.">
      <Group gap={4} wrap="nowrap" px={6}>
        <Box
          w={28}
          h={4}
          style={{ borderRadius: 2, backgroundColor: "var(--mantine-color-dark-5)", overflow: "hidden" }}
        >
          <Box bg="orange.5" h={4} style={{ width: `${percent}%`, transition: "width 200ms linear" }} />
        </Box>
        <Text fz="xs" c="dark.2">
          Effects
        </Text>
      </Group>
    </Tooltip>
  );
}
