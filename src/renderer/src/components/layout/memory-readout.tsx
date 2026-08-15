import { Box, Group, Text } from "@mantine/core";
import { usedBudgetFraction } from "@renderer/lib/gpu-budget";
import { helpProps } from "@renderer/lib/ui-controls";
import { openFiles } from "@renderer/store/files";
import { useEffect, useState } from "react";
import { Tooltip } from "../tooltip";

const POLL_MS = 2000;

function openFileTexelCounts(): number[] {
  const counts: number[] = [];
  for (const file of Object.values(openFiles)) {
    const data = file.spectrogramData;
    if (data) counts.push(data.textureWidth * data.textureHeight);
  }
  return counts;
}

/** Share of the graphics memory budget the open files hold. */
export function MemoryReadout() {
  const [fraction, setFraction] = useState<number | undefined>(undefined);

  useEffect(() => {
    const read = () => setFraction(usedBudgetFraction(openFileTexelCounts()));
    read();
    const timer = setInterval(read, POLL_MS);
    return () => clearInterval(timer);
  }, []);

  if (fraction === undefined) return null;

  const percent = Math.min(999, Math.round(fraction * 100));
  const colour = percent >= 90 ? "red.5" : percent >= 70 ? "yellow.5" : "dark.2";

  return (
    <Tooltip help="menu-memory">
      <Group gap={4} wrap="nowrap" px={6} {...helpProps("menu-memory")}>
        <Box
          w={28}
          h={4}
          style={{ borderRadius: 2, backgroundColor: "var(--mantine-color-dark-5)", overflow: "hidden" }}
        >
          <Box bg={colour} h={4} style={{ width: `${Math.min(100, percent)}%`, transition: "width 200ms linear" }} />
        </Box>
        <Text fz="xs" c={colour} ff="monospace">
          {percent}%
        </Text>
      </Group>
    </Tooltip>
  );
}
