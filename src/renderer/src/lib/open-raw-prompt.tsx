import { Stack, Text } from "@mantine/core";
import { modals } from "@mantine/modals";
import type { RefObject } from "react";
import { OpenRawFields } from "../components/open-raw-fields";
import { useStore } from "../store";
import { openConfirmModal } from "./modals";
import { rawDialogOutcome, rawOpenOptions } from "./raw-dialog";
import type { RawOpenOptions } from "./raw-file";

type OpenRawPromptOptions = {
  fileName: string;
  fileSize: number;
  onConfirm: (options: RawOpenOptions) => void | Promise<void>;
};

export function openRawPrompt({ fileName, fileSize, onConfirm }: OpenRawPromptOptions): void {
  const modalId: RefObject<string> = { current: "" };
  const confirmProps = { size: "xs" } as const;
  const ready = (): boolean => "seconds" in rawDialogOutcome(useStore.getState(), fileSize);

  modalId.current = openConfirmModal({
    title: "Open Raw",
    size: "sm",
    children: (
      <Stack gap="sm">
        <Text size="sm" c="dimmed">
          Reads the bytes of {fileName} as sound.
        </Text>
        <OpenRawFields
          fileSize={fileSize}
          onOutcome={(outcome) => {
            modals.updateModal({
              modalId: modalId.current,
              confirmProps: { ...confirmProps, disabled: !("seconds" in outcome) },
            });
          }}
        />
      </Stack>
    ),
    labels: { confirm: "Open", cancel: "Cancel" },
    confirmProps: { ...confirmProps, disabled: true },
    cancelProps: { size: "xs" },
    onConfirm: async () => {
      if (!ready()) return;
      await onConfirm(rawOpenOptions(useStore.getState(), fileSize));
    },
  });
}
