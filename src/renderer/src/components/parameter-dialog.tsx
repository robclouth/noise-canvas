import { Button, Group, Stack, Text } from "@mantine/core";
import type { ContextModalProps } from "@mantine/modals";
import { FILE_LENGTH_KEYS, SILENCE_LENGTH_KEYS } from "@renderer/lib/length-values";
import type { ReactNode } from "react";
import { DialogControls } from "./dialog-controls";
import { GenerateFields } from "./generate-fields";
import { LengthFields } from "./length-fields";

/** The dialogs whose fields are parameters, so they open on the values last used. */
export type ParameterDialogBody =
  | { kind: "newFile" }
  | { kind: "splitParts" }
  | { kind: "insertSilence"; bpm: number }
  | { kind: "setLength"; bpm: number }
  | { kind: "generate"; hasSelection: boolean; bandLimited: boolean };

export type ParameterDialogProps = {
  body: ParameterDialogBody;
  confirmLabel: string;
  /** Runs as the dialog closes; the caller reads the values from the store. */
  onConfirm: () => void | Promise<void>;
};

function bodyContent(body: ParameterDialogBody): ReactNode {
  switch (body.kind) {
    case "newFile":
      return <DialogControls keys={["newFileSampleRate", "newFileBpm", "newFileLengthBeats"]} />;
    case "splitParts":
      return (
        <Stack gap="xs">
          <Text size="sm" c="dimmed">
            Factorises the spectrogram into layers that each capture a recurring sound, ordered from lowest to highest.
            The parts stay linked and add back up to this file.
          </Text>
          <DialogControls keys={["splitParts"]} />
        </Stack>
      );
    case "insertSilence":
      return <LengthFields keys={SILENCE_LENGTH_KEYS} bpm={body.bpm} />;
    case "setLength":
      return (
        <Stack gap="xs">
          <Text size="sm" c="dimmed">
            Cuts the file short, or pads it with silence, to the length you give.
          </Text>
          <LengthFields keys={FILE_LENGTH_KEYS} bpm={body.bpm} />
        </Stack>
      );
    case "generate":
      return (
        <Stack gap="sm">
          <Text size="sm" c="dimmed">
            {body.hasSelection
              ? "Makes new sound for the selection from a prompt. At 100% it replaces the selection, carrying on from the sound around it; lower keeps more of what is there."
              : "Makes new sound for the whole file from a prompt. At 100% it replaces the file; lower keeps more of what is there."}
          </Text>
          <GenerateFields bandLimited={body.bandLimited} />
        </Stack>
      );
  }
}

/** A dialog of parameter controls with Cancel and a confirm button. */
export const ParameterDialogModal = ({
  context,
  id,
  innerProps: { body, confirmLabel, onConfirm },
}: ContextModalProps<ParameterDialogProps>) => (
  <Stack gap="md">
    {bodyContent(body)}
    <Group justify="flex-end" gap="xs">
      <Button size="xs" variant="default" onClick={() => context.closeModal(id)}>
        Cancel
      </Button>
      <Button
        size="xs"
        onClick={() => {
          void onConfirm();
          context.closeModal(id);
        }}
      >
        {confirmLabel}
      </Button>
    </Group>
  </Stack>
);
