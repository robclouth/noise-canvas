import { BaseEffect } from "./base-effect";
import { blurEffect } from "./blur-effect";
import { gainEffect } from "./gain-effect";
import { harmonicsEffect } from "./harmonics-effect";
import { passThroughEffect } from "./passthrough-effect";
import { sharpenEffect } from "./sharpen-effect";
import { synthesizeEffect } from "./synthesize-effect";
import { transformEffect } from "./transform-effect";

export const effects: Record<string, BaseEffect> = {
  gain: gainEffect,
  transform: transformEffect,
  harmonics: harmonicsEffect,
  blur: blurEffect,
  synthesize: synthesizeEffect,
  sharpen: sharpenEffect,
  passthrough: passThroughEffect,
};

export type EffectType = keyof typeof effects;
