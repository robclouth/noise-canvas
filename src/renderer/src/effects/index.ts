import { binauralEffect } from "./binaural-effect";
import { blurEffect } from "./blur-effect";
import { cloneEffect } from "./clone-effect";
import { dynamicsEffect } from "./dynamics-effect";
import { evolveEffect } from "./evolve-effect";
import { overtonesEffect } from "./overtones-effect";
import { passThroughEffect } from "./passthrough-effect";
import { sortEffect } from "./sort-effect";
import { synthesizeEffect } from "./synthesize-effect";
import { transformEffect } from "./transform-effect";
import { transmuteEffect } from "./transmute-effect";
import { waveshapeEffect } from "./waveshape-effect";

// Re-export types from the types module (which has no circular dependencies)
export { DEFAULT_EFFECT_ORDER, EFFECT_KEYS } from "./types";
export type { EffectType } from "./types";

export const effects = {
  dynamics: dynamicsEffect,
  transform: transformEffect,
  overtones: overtonesEffect,
  blur: blurEffect,
  clone: cloneEffect,
  synthesize: synthesizeEffect,
  evolve: evolveEffect,
  passthrough: passThroughEffect,
  binaural: binauralEffect,
  sort: sortEffect,
  transmute: transmuteEffect,
  waveshape: waveshapeEffect,
};
