import { create } from "zustand";
import { gridCeiling, gridRoughness, PackedSpectrogram, readAnchors, readGrid, UvRect } from "./nca-grid";
import { serializeModel } from "./nca-model";

/** Iterations a learn runs unless stopped sooner. */
export const NCA_TRAINING_ITERATIONS = 2000;
/** Other stretches of the same file the model also learns to grow from. */
const CONTEXT_REGIONS = 8;

export type NcaTrainingJob = {
  effectId: string;
  label: string;
  iteration: number;
  iterations: number;
  loss: number;
  /** The sound being learnt, as the grid sees it. */
  target: Float32Array;
  /** What the model grows at the latest iteration. */
  output: Float32Array | null;
  status: "preparing" | "running" | "finished" | "failed";
  error?: string;
};

/** The one learn that is running, or the last one to end. */
export const useNcaTraining = create<{ job: NcaTrainingJob | null }>(() => ({ job: null }));

let controller: AbortController | null = null;

function update(patch: Partial<NcaTrainingJob>): void {
  const job = useNcaTraining.getState().job;
  if (job) useNcaTraining.setState({ job: { ...job, ...patch } });
}

function randomRegionLike(rect: UvRect, random: () => number): UvRect {
  const width = rect.x1 - rect.x0;
  const height = rect.y1 - rect.y0;
  const x0 = random() * Math.max(0, 1 - width);
  const y0 = random() * Math.max(0, 1 - height);
  return { x0, y0, x1: x0 + width, y1: y0 + height };
}

/**
 * Learns the sound inside `rect` and hands the finished model to `apply`, as
 * the string the effect's Model parameter stores. Stopping early still applies
 * what was learnt so far. A learn already running is stopped first.
 */
export async function startNcaTraining(request: {
  effectId: string;
  label: string;
  rect: UvRect;
  readSpectrogram: () => Promise<PackedSpectrogram>;
  apply: (modelText: string) => void;
  iterations?: number;
}): Promise<void> {
  stopNcaTraining();
  const own = new AbortController();
  controller = own;
  const iterations = request.iterations ?? NCA_TRAINING_ITERATIONS;
  useNcaTraining.setState({
    job: {
      effectId: request.effectId,
      label: request.label,
      iteration: 0,
      iterations,
      loss: NaN,
      target: new Float32Array(0),
      output: null,
      status: "preparing",
    },
  });

  try {
    const spectrogram = await request.readSpectrogram();
    const target = readGrid(spectrogram, request.rect);
    const context = [
      target,
      ...Array.from({ length: CONTEXT_REGIONS }, () =>
        readGrid(spectrogram, randomRegionLike(request.rect, Math.random)),
      ),
    ];
    update({ target, status: "running" });

    const tf = await import("@tensorflow/tfjs-core");
    await import("@tensorflow/tfjs-backend-webgl");
    if (!(await tf.setBackend("webgl"))) {
      await import("@tensorflow/tfjs-backend-cpu");
      await tf.setBackend("cpu");
    }
    const { trainNca } = await import("./nca-train");
    const result = await trainNca(
      target,
      context,
      { iterations },
      (progress) => {
        if (controller === own) update({ iteration: progress.iteration, loss: progress.loss, output: progress.output });
      },
      own.signal,
    );
    if (result.iterations > 0) {
      request.apply(
        serializeModel({
          ...result,
          label: request.label,
          phase: readAnchors(spectrogram, request.rect),
          roughness: gridRoughness(target),
          ceiling: gridCeiling(target),
        }),
      );
    }
    if (controller === own) update({ status: "finished" });
  } catch (error) {
    if (controller === own) update({ status: "failed", error: error instanceof Error ? error.message : String(error) });
  } finally {
    if (controller === own) controller = null;
  }
}

/** Stops the running learn; it keeps and applies what it has learnt so far. */
export function stopNcaTraining(): void {
  controller?.abort();
}
