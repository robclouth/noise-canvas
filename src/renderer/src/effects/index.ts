import { BaseEffect } from "./base-effect";
import { blurEffect } from "./blur-effect";
import { dynamicsEffect } from "./dynamics-effect";
import { overtonesEffect } from "./overtones-effect";
import { passThroughEffect } from "./passthrough-effect";
import { synthesizeEffect } from "./synthesize-effect";
import { transformEffect } from "./transform-effect";

export const effects: Record<string, BaseEffect> = {
  dynamics: dynamicsEffect,
  transform: transformEffect,
  overtones: overtonesEffect,
  blur: blurEffect,
  synthesize: synthesizeEffect,
  passthrough: passThroughEffect,
};

export type EffectType = keyof typeof effects;
