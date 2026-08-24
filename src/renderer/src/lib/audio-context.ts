import * as Tone from "tone";

let installed = false;

/**
 * Puts Tone on a native AudioContext. Tone builds a wrapper context of its own
 * otherwise, and only the native one carries `setSinkId`, which is what routes
 * playback to a chosen output. Must run before anything creates a Tone node,
 * since nodes stay bound to the context they were made on.
 */
export function installNativeAudioContext(): void {
  if (installed) return;
  installed = true;
  if (typeof AudioContext !== "function") return;
  Tone.setContext(new AudioContext({ latencyHint: "interactive" }));
}
