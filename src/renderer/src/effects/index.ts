import { BaseEffect } from "./base-effect";
import { blurEffect } from "./blur-effect";
import { dynamicsEffect } from "./dynamics-effect";
import { gainEffect } from "./gain-effect";
import { harmonicsEffect } from "./harmonics-effect";
import { passThroughEffect } from "./passthrough-effect";
import { synthesizeEffect } from "./synthesize-effect";
import { transformEffect } from "./transform-effect";

export const effects: Record<string, BaseEffect> = {
  gain: gainEffect,
  dynamics: dynamicsEffect,
  transform: transformEffect,
  harmonics: harmonicsEffect,
  blur: blurEffect,
  synthesize: synthesizeEffect,
  passthrough: passThroughEffect,
};

export type EffectType = keyof typeof effects;
