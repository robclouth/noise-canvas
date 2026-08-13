import { Button, Group, Modal, Progress, Stack, Text } from "@mantine/core";
import { useStore } from "@renderer/store";

/**
 * Shows how far a large grid fill has got, and offers to stop it. Cancelling
 * puts back the pixels from before the fill started, so nothing is committed.
 */
export const FillProgressModal = () => {
  const progress = useStore((state) => state.fillProgress);
  const cancelFill = useStore((state) => state.cancelFill);

  const percent = progress && progress.total > 0 ? (progress.done / progress.total) * 100 : 0;

  return (
    <Modal
      opened={progress !== null}
      onClose={cancelFill}
      title="Filling grid"
      centered
      size="sm"
      closeOnClickOutside={false}
      withCloseButton={false}
    >
      <Stack gap="sm">
        <Progress value={percent} animated />
        <Text size="xs" c="dimmed">
          {progress ? `${progress.done.toLocaleString()} of ${progress.total.toLocaleString()} strokes` : ""}
        </Text>
        <Group justify="flex-end">
          <Button size="xs" variant="light" color="gray" onClick={cancelFill}>
            Cancel
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
};
