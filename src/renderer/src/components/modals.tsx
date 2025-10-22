import { Button, NumberInput, SimpleGrid, Stack } from "@mantine/core";
import { ContextModalProps } from "@mantine/modals";
import { useRef } from "react";

export const NewFileModal = ({
  context,
  id,
  innerProps: { resolve },
}: ContextModalProps<{
  resolve: ({ sampleRate, bpm, lengthBeats }: { sampleRate: number; bpm: number; lengthBeats: number }) => void;
}>) => {
  const sampleRateRef = useRef<HTMLInputElement>(null);
  const bpmRef = useRef<HTMLInputElement>(null);
  const lengthRef = useRef<HTMLInputElement>(null);

  return (
    <Stack gap="sm">
      <SimpleGrid cols={2} spacing="sm">
        <NumberInput
          ref={sampleRateRef}
          size="xs"
          label="Sample rate"
          defaultValue={44100}
          min={8000}
          max={192000}
          step={1000}
          variant="unstyled"
          hideControls
        />
        <NumberInput
          ref={bpmRef}
          size="xs"
          label="BPM"
          defaultValue={120}
          min={1}
          max={999}
          step={1}
          variant="unstyled"
          hideControls
        />
        <NumberInput
          ref={lengthRef}
          size="xs"
          label="Length beats"
          defaultValue={16}
          min={1}
          max={64}
          step={1}
          variant="unstyled"
          hideControls
        />
      </SimpleGrid>
      <Button
        size="xs"
        fullWidth
        onClick={() => {
          context.closeModal(id);
          resolve({
            sampleRate: parseInt(sampleRateRef.current!.value),
            bpm: parseInt(bpmRef.current!.value),
            lengthBeats: parseInt(lengthRef.current!.value),
          });
        }}
      >
        Create file
      </Button>
    </Stack>
  );
};

// eslint-disable-next-line react-refresh/only-export-components
export const modals = {
  newFile: NewFileModal,
};
