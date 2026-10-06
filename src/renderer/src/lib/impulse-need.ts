import { createEffectStateView, createStepStateView } from "@renderer/store";
import type { SpectrogramData, State } from "@renderer/store/types";
import { attractFieldKey, impulseKey, responsePath } from "./impulse-key";
import { modulatedRange } from "./modulation-range";
import type { SourceNeed } from "./source-window";

/** An open file a convolve step can filter through. */
export type ResponseFile = { id: string; spectrogramData: SpectrogramData };

/** The response one convolve step reads, under the key the effect looks it up by. */
export type ImpulseNeed = { key: string; need: SourceNeed };

/**
 * The response every enabled convolve step reads, and the frames of it the
 * taps cover. `resolve` takes the path a step names, or null for the file the
 * dab lands on.
 *
 * The taps run forward from IR Start, one response bin each, and the coarsest
 * band's bin is the longest, so that band's stride sets the span. Steps that
 * read the same response share one entry, over every frame they ask for.
 */
export function impulseNeeds(state: State, resolve: (path: string | null) => ResponseFile | null): ImpulseNeed[] {
  const steps = state.brushes[state.activeBrushIndex]?.steps ?? [];
  const byKey = new Map<string, SourceNeed>();
  for (let index = 0; index < steps.length; index++) {
    const step = createStepStateView(state, index);
    for (const item of step.effects) {
      if (!item.enabled || item.effect !== "convolve") continue;
      const effect = createEffectStateView(state, index, item);
      const file = resolve(responsePath(effect));
      if (!file) continue;
      const key = impulseKey(effect);
      const need = tapSpan(effect, file);
      const held = byKey.get(key);
      byKey.set(
        key,
        held
          ? {
              ...need,
              startFrame: Math.min(held.startFrame, need.startFrame),
              endFrame: Math.max(held.endFrame, need.endFrame),
            }
          : need,
      );
    }
  }
  return [...byKey].map(([key, need]) => ({ key, need }));
}

/** The frames of the response the taps read, from the earliest IR Start modulation can reach to the latest. */
function tapSpan(effect: State, file: ResponseFile): SourceNeed {
  const { numFrames, synthesisMetadata } = file.spectrogramData;
  const stride = 1 << Math.max(...synthesisMetadata.bandStepLog2s);
  const taps = Math.max(1, Math.floor(Number(effect.convolveIrSize)));
  const start = modulatedRange(effect, "convolveIrTimeOffset", Number(effect.convolveIrTimeOffset));
  return {
    fileId: file.id,
    startFrame: Math.max(0, Math.floor((start.lo / 100) * numFrames)),
    endFrame: Math.min(numFrames, Math.ceil((start.hi / 100) * numFrames + taps * stride)),
    wantOriginal: false,
  };
}

/**
 * The span of every picked Attract field file a dab reads. The field is laid
 * over the painted file in proportion, so a dab over `destSpan` of the
 * painted file's `destFrames` reads the same share of the field, a bin of the
 * field's coarsest band wider either side for the read between bins. With no
 * span the whole field is read.
 */
export function attractFieldNeeds(
  state: State,
  resolve: (path: string) => ResponseFile | null,
  destSpan: { startFrame: number; endFrame: number } | null,
  destFrames: number,
): ImpulseNeed[] {
  const steps = state.brushes[state.activeBrushIndex]?.steps ?? [];
  const byKey = new Map<string, SourceNeed>();
  for (let index = 0; index < steps.length; index++) {
    const step = createStepStateView(state, index);
    for (const item of step.effects) {
      if (!item.enabled || item.effect !== "attract") continue;
      const effect = createEffectStateView(state, index, item);
      const path = effect.attractSourceFile?.path;
      if (Number(effect.attractMap) !== 0 || !path) continue;
      const file = resolve(path);
      if (!file) continue;
      const { numFrames, synthesisMetadata } = file.spectrogramData;
      const stride = 1 << Math.max(...synthesisMetadata.bandStepLog2s);
      const scale = numFrames / Math.max(destFrames, 1);
      const need: SourceNeed = destSpan
        ? {
            fileId: file.id,
            startFrame: Math.max(0, Math.floor(destSpan.startFrame * scale) - stride),
            endFrame: Math.min(numFrames, Math.ceil(destSpan.endFrame * scale) + stride),
            wantOriginal: false,
          }
        : { fileId: file.id, startFrame: 0, endFrame: numFrames, wantOriginal: false };
      const key = attractFieldKey(path);
      const held = byKey.get(key);
      byKey.set(
        key,
        held
          ? {
              ...need,
              startFrame: Math.min(held.startFrame, need.startFrame),
              endFrame: Math.max(held.endFrame, need.endFrame),
            }
          : need,
      );
    }
  }
  return [...byKey].map(([key, need]) => ({ key, need }));
}

/**
 * The bindings with every need on one file widened to all of them: a file is
 * read through one window, so each key reading it shares the same span.
 */
export function mergeNeedsByFile(bindings: readonly ImpulseNeed[]): ImpulseNeed[] {
  const byFile = new Map<string, SourceNeed>();
  for (const { need } of bindings) {
    const held = byFile.get(need.fileId);
    byFile.set(
      need.fileId,
      held
        ? {
            ...held,
            startFrame: Math.min(held.startFrame, need.startFrame),
            endFrame: Math.max(held.endFrame, need.endFrame),
          }
        : need,
    );
  }
  return bindings.map(({ key, need }) => ({ key, need: byFile.get(need.fileId) ?? need }));
}
