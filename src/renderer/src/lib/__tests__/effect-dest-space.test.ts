import { Vector2 } from "three";
import { describe, expect, it } from "vitest";

import { createDefaultUniforms, type CommonUniforms } from "../../effects/base-effect";
import { effects } from "../../effects";
import { createMockSpectrogramData } from "../../test/mock-spectrogram";
import { createMockState } from "../../test/mock-state";
import type { OpenFile, State } from "../../store/types";

/**
 * Transform and Attract convert beats and semitones into UV and then move the
 * result in destination UV space. `props.file` is the *source* file, so a stroke
 * painted from one file onto another must not read its layout from there.
 */

const SOURCE = createMockSpectrogramData({ numFrames: 256, numBands: 32, sampleRate: 1000 });
const DEST = createMockSpectrogramData({ numFrames: 1024, numBands: 64, sampleRate: 1000 });

const SOURCE_BPM = 120;
const DEST_BPM = 60;

function sourceFile(): OpenFile {
  return {
    id: "source",
    filePath: "/test/source.wav",
    displayName: "source.wav",
    spectrogramData: SOURCE,
  } as unknown as OpenFile;
}

function destUniforms(): CommonUniforms {
  const uniforms = createDefaultUniforms();
  uniforms.bpm.value = DEST_BPM;
  uniforms.destFrameCount.value = DEST.numFrames;
  uniforms.destBandCount.value = DEST.numBands;
  uniforms.destSampleRate.value = DEST.sampleRate;
  uniforms.destBandsPerOctave.value = DEST.bandsPerOctave;
  uniforms.destMinFreq.value = DEST.minFreq;
  uniforms.brushBottomLeftUv.value = new Vector2(0, 0);
  return uniforms;
}

function stateWith(overrides: Partial<State>): State {
  return createMockState({
    filepathsBpm: { "/test/source.wav": SOURCE_BPM },
    ...overrides,
  } as Partial<State>);
}

describe("effects that transform in destination space", () => {
  it("converts Transform's beat shift with the destination's tempo and length", () => {
    const commonUniforms = destUniforms();
    effects.transform.updateEffectUniforms({
      commonUniforms,
      passIndex: 0,
      file: sourceFile(),
      state: stateWith({ transformShiftBeats: 1, transformShiftSemis: 0 } as Partial<State>),
    });

    // One beat at the destination's tempo, as a fraction of its own length.
    const destDuration = DEST.numFrames / DEST.sampleRate;
    const expected = 60 / DEST_BPM / destDuration;
    const shiftX = effects.transform.materials[0].uniforms.shiftX.value as { value: number };
    expect(shiftX.value).toBeCloseTo(expected, 6);

    // The source's own layout would give a different, wrong answer.
    const sourceDuration = SOURCE.numFrames / SOURCE.sampleRate;
    expect(expected).not.toBeCloseTo(60 / SOURCE_BPM / sourceDuration, 6);
  });

  it("converts Transform's semitone shift with the destination's band layout", () => {
    const commonUniforms = destUniforms();
    effects.transform.updateEffectUniforms({
      commonUniforms,
      passIndex: 0,
      file: sourceFile(),
      state: stateWith({ transformShiftBeats: 0, transformShiftSemis: 12 } as Partial<State>),
    });

    const expected = (12 * (DEST.bandsPerOctave / 12)) / DEST.numBands;
    const shiftY = effects.transform.materials[0].uniforms.shiftY.value as { value: number };
    expect(shiftY.value).toBeCloseTo(expected, 6);
  });

  it("sizes Attract's beat lattice from the destination", () => {
    const commonUniforms = destUniforms();
    effects.attract.updateEffectUniforms({
      commonUniforms,
      passIndex: 1,
      file: sourceFile(),
      state: stateWith({ attractMap: 0 } as Partial<State>),
    });

    const destDuration = DEST.numFrames / DEST.sampleRate;
    const expected = 60 / DEST_BPM / destDuration;
    expect(effects.attract.materials[1].uniforms.attractUvPerBeat.value as number).toBeCloseTo(expected, 6);
  });
});
