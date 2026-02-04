import { binauralEffect } from "./binaural-effect";
import { blurEffect } from "./blur-effect";
import { dynamicsEffect } from "./dynamics-effect";
import { evolveEffect } from "./evolve-effect";
import { overtonesEffect } from "./overtones-effect";
import { passThroughEffect } from "./passthrough-effect";
import { synthesizeEffect } from "./synthesize-effect";
import { transformEffect } from "./transform-effect";

// Re-export types from the types module (which has no circular dependencies)
export type { EffectType } from "./types";
export { EFFECT_KEYS, DEFAULT_EFFECT_ORDER } from "./types";

export const effects = {
  dynamics: dynamicsEffect,
  transform: transformEffect,
  overtones: overtonesEffect,
  blur: blurEffect,
  synthesize: synthesizeEffect,
  evolve: evolveEffect,
  passthrough: passThroughEffect,
  binaural: binauralEffect,
};
