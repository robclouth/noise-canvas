import type { ParameterKey } from "@/store/types";
import { SimpleGrid, Stack, Text } from "@mantine/core";
import { formatRawDuration, rawDialogOutcome } from "@renderer/lib/raw-dialog";
import { useStore } from "@renderer/store";
import { useEffect } from "react";
import { useShallow } from "zustand/shallow";
import { ParameterControl } from "./controls/parameter-control";

type Outcome = ReturnType<typeof rawDialogOutcome>;

/** The body of the Open Raw dialog: the stored settings, and what they make of a file of `fileSize` bytes. */
export const OpenRawFields = ({ fileSize, onOutcome }: { fileSize: number; onOutcome: (outcome: Outcome) => void }) => {
  const outcome = useStore(useShallow((state) => rawDialogOutcome(state, fileSize)));
  const read = useStore((state) => state.rawRead);
  useEffect(() => onOutcome(outcome), [outcome, onOutcome]);

  const keys: ParameterKey[] = [
    "rawRead",
    "rawFormat",
    "rawSpeed",
    "rawStereo",
    "rawRemoveNoise",
    "rawBytes",
    ...(read === "hold" ? (["rawHoldLength"] as const) : []),
  ];

  return (
    <Stack gap="sm">
      <SimpleGrid cols={2} spacing="xs" verticalSpacing={0}>
        {keys.map((key) => (
          <ParameterControl key={key} paramKey={key} plainLabel />
        ))}
      </SimpleGrid>
      <Text size="xs" c={"problem" in outcome ? "red" : "dimmed"}>
        {"problem" in outcome ? outcome.problem : `Makes ${formatRawDuration(outcome.seconds)} of sound.`}
      </Text>
    </Stack>
  );
};
