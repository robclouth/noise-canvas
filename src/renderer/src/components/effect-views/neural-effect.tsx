import { Group, Progress, Stack, Text } from "@mantine/core";
import { useEffectId } from "@renderer/contexts/effect-context";
import { EFFECT_COLORS } from "@renderer/lib/constants";
import { NCA_GRID, NCA_VISIBLE, parseModel } from "@renderer/lib/nca/nca-model";
import { stopNcaTraining, useNcaTraining } from "@renderer/lib/nca/nca-training";
import { getEffectParameterValue, useStore } from "@renderer/store";
import { memo, useEffect, useMemo, useRef } from "react";
import { HelpButton } from "../controls/help-control";
import { ParameterControl } from "../controls/parameter-control";

const COLOR = EFFECT_COLORS.neural;

/** The level channel of a grid as a small greyscale picture, low pitch at the bottom. */
const GridPicture = memo(function GridPicture({ grid, caption }: { grid: Float32Array | null; caption: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const context = canvasRef.current?.getContext("2d");
    if (!context) return;
    const image = context.createImageData(NCA_GRID, NCA_GRID);
    for (let row = 0; row < NCA_GRID; row++) {
      for (let col = 0; col < NCA_GRID; col++) {
        const level = grid ? grid[(row * NCA_GRID + col) * NCA_VISIBLE] : 0;
        const shade = Math.round(255 * Math.min(1, Math.max(0, level)));
        const i = ((NCA_GRID - 1 - row) * NCA_GRID + col) * 4;
        image.data[i] = image.data[i + 1] = image.data[i + 2] = shade;
        image.data[i + 3] = 255;
      }
    }
    context.putImageData(image, 0, 0);
  }, [grid]);
  return (
    <Stack gap={2} align="center">
      <canvas
        ref={canvasRef}
        width={NCA_GRID}
        height={NCA_GRID}
        style={{ width: 96, height: 96, imageRendering: "pixelated", borderRadius: 2 }}
      />
      <Text size="xs" c="dimmed">
        {caption}
      </Text>
    </Stack>
  );
});

export const NeuralEffect = memo(function NeuralEffect() {
  const effectId = useEffectId();
  const modelText = useStore((state) => (effectId ? getEffectParameterValue(state, effectId, "neuralModel") : ""));
  const picking = useStore((state) => state.pickingFileParam === "neuralModel" && state.pickingEffectId === effectId);
  const job = useNcaTraining((state) => (state.job?.effectId === effectId ? state.job : null));
  const model = useMemo(() => parseModel(modelText), [modelText]);
  const learning = job?.status === "preparing" || job?.status === "running";

  const status = learning
    ? `Learning ${job.label}`
    : picking
      ? "Click a spectrogram to learn the sound under the brush."
      : job?.status === "failed"
        ? `Learning failed: ${job.error}`
        : model
          ? `Grows ${model.label}`
          : "Nothing learnt yet.";

  return (
    <Stack gap={6}>
      <Group gap="xs" wrap="nowrap" justify="space-between">
        <Text size="xs" c={job?.status === "failed" ? "red" : "dimmed"} style={{ overflowWrap: "anywhere" }}>
          {status}
        </Text>
        {learning ? (
          <HelpButton help="neural-stop" size="compact-xs" variant="light" color={COLOR} onClick={stopNcaTraining}>
            Stop
          </HelpButton>
        ) : (
          <HelpButton
            help="neural-learn"
            size="compact-xs"
            variant={picking ? "filled" : "light"}
            color={COLOR}
            onClick={() => useStore.getState().setPickingFileParam(picking ? null : "neuralModel", effectId)}
          >
            Learn
          </HelpButton>
        )}
      </Group>
      {learning && job && (
        <>
          <Progress value={(job.iteration / job.iterations) * 100} color={COLOR} size="xs" />
          <Group gap="md" justify="center">
            <GridPicture grid={job.target.length > 0 ? job.target : null} caption="Target" />
            <GridPicture grid={job.output} caption={`Growing, ${job.iteration}/${job.iterations}`} />
          </Group>
        </>
      )}
      <ParameterControl paramKey="neuralSteps" color={COLOR} />
    </Stack>
  );
});
