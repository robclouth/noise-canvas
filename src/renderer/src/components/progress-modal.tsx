import { Button, Group, Modal, Progress, Stack, Text } from "@mantine/core";
import type { JobProgress } from "@renderer/store/edit-progress";

/** A dialog showing how far a long job has got, counted in `unit`, with a button that stops it. */
export const ProgressModal = ({
  title,
  unit,
  progress,
  onCancel,
}: {
  title: string;
  unit: string;
  progress: JobProgress | null;
  onCancel: () => void;
}) => {
  const percent = progress && progress.total > 0 ? (progress.done / progress.total) * 100 : 0;

  return (
    <Modal
      opened={progress !== null}
      onClose={onCancel}
      title={title}
      centered
      size="sm"
      closeOnClickOutside={false}
      withCloseButton={false}
    >
      <Stack gap="sm">
        <Progress value={percent} animated />
        <Text size="xs" c="dimmed">
          {progress ? `${progress.done.toLocaleString()} of ${progress.total.toLocaleString()} ${unit}` : ""}
        </Text>
        <Group justify="flex-end">
          <Button size="xs" variant="light" color="gray" onClick={onCancel}>
            Cancel
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
};
