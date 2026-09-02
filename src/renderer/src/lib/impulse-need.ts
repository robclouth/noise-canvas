import { createEffectStateView, createStepStateView } from "@renderer/store";
import type { SpectrogramData, State } from "@renderer/store/types";
import { impulseKey, responsePath } from "./impulse-key";
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

function tapSpan(effect: State, file: ResponseFile): SourceNeed {
  const { numFrames, synthesisMetadata } = file.spectrogramData;
  const stride = 1 << Math.max(...synthesisMetadata.bandStepLog2s);
  const taps = Math.max(1, Math.floor(Number(effect.convolveIrSize)));
  const start = (Number(effect.convolveIrTimeOffset) / 100) * numFrames;
  return {
    fileId: file.id,
    startFrame: Math.max(0, Math.floor(start)),
    endFrame: Math.min(numFrames, Math.ceil(start + taps * stride)),
    wantOriginal: false,
  };
}
