import { createRequire } from "node:module";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { GaboratorAnalysisResult } from "../types";

// Exercises the addon's onset detector against real Gaborator analyses. Every
// signal here has event times known by construction, so timing is asserted in
// absolute terms: a transform that re-anchors phase at an onset displaces the
// transient by (pitchRatio − 1) × the timing error, which at three octaves down
// turns half a millisecond of detector error into several milliseconds of
// misplaced attack.
//
// Detection is deliberately permissive — it reports every plausible peak with a
// continuous salience and leaves the choice of which ones count to the UI's
// sensitivity control. The cases below therefore assert on onsets above a
// salience floor standing in for that control, and on the separation between
// real events and the things that must stay below it.

const require = createRequire(import.meta.url);

type OnsetMeta = {
  numBands: number;
  numChannels: number;
  numFrames: number;
  bandOffsets: Uint32Array;
  bandLengths: Uint32Array;
  bandStepLog2s: Int32Array;
};

const addon = require(join(__dirname, "../../../../build/Release/gaborator_addon.node")) as {
  analyze: (
    channels: Float32Array[],
    numChannels: number,
    sampleRate: number,
    params: { bandsPerOctave: number; minFreq: number },
  ) => Promise<GaboratorAnalysisResult>;
  detectOnsets: (packedData: Float32Array, meta: OnsetMeta, sampleRate: number) => Promise<{ onsets: Float32Array }>;
  synthesize: (
    data: Float32Array,
    analysis: GaboratorAnalysisResult,
    sampleRate: number,
    params: { bandsPerOctave: number; minFreq: number; detectOnsets?: boolean },
    applyLimiter: boolean,
    existingAudio: Float32Array[],
  ) => Promise<{ channels: Float32Array[]; onsets?: Float32Array }>;
};

const SR = 48000;
const PARAMS = { bandsPerOctave: 36, minFreq: 27.5 };
// Analysis walks every coefficient of a real signal, past vitest's default.
const TIMEOUT = 240_000;
// Salience a peak must reach to count as an event. Percussive hits here land
// between 4.5 and 13; the pre-ring of an impulse in the slow bands and the
// wobble of a vibrato tone stay near 2.
const SALIENCE_FLOOR = 4;

type Onset = { timeSec: number; salience: number };

function metaOf(analysis: GaboratorAnalysisResult): OnsetMeta {
  return {
    numBands: analysis.numBands,
    numChannels: analysis.numChannels,
    numFrames: analysis.numFrames,
    bandOffsets: analysis.bandOffsets,
    bandLengths: analysis.bandLengths,
    bandStepLog2s: analysis.bandStepLog2s,
  };
}

function unpack(flat: Float32Array): Onset[] {
  const onsets: Onset[] = [];
  for (let i = 0; i + 1 < flat.length; i += 2) {
    onsets.push({ timeSec: flat[i], salience: flat[i + 1] });
  }
  return onsets;
}

async function onsetsOf(signal: Float32Array[]): Promise<Onset[]> {
  const analysis = await addon.analyze(signal, signal.length, SR, PARAMS);
  const result = await addon.detectOnsets(analysis.data, metaOf(analysis), SR);
  return unpack(result.onsets);
}

function silence(durationSec: number): Float32Array {
  return new Float32Array(Math.round(SR * durationSec));
}

function mixInto(target: Float32Array, source: Float32Array): void {
  for (let i = 0; i < target.length; i++) target[i] += source[i];
}

/** A single-sample click at an exact sample index, so its true time is known. */
function makeImpulse(durationSec: number, sampleIndex: number): Float32Array {
  const buf = silence(durationSec);
  buf[sampleIndex] = 1;
  return buf;
}

/**
 * A high-frequency noise burst with an exponential decay — a hi-hat. The attack
 * is one event; the decay must not be mistaken for a run of further ones.
 */
function makeHat(durationSec: number, startSec: number, decaySec: number): Float32Array {
  const buf = silence(durationSec);
  const start = Math.round(startSec * SR);
  let state = 12345;
  let prev = 0;
  for (let i = start; i < buf.length; i++) {
    state = (state * 1664525 + 1013904223) >>> 0;
    const white = (state / 0xffffffff) * 2 - 1;
    // One-zero high-pass, so the burst sits where a hat sits.
    const high = white - prev;
    prev = white;
    buf[i] = high * Math.exp(-(i - start) / (decaySec * SR));
  }
  return buf;
}

function makeHatPattern(durationSec: number, hits: number[], decaySec = 0.12): Float32Array {
  const buf = silence(durationSec);
  for (const t of hits) mixInto(buf, makeHat(durationSec, t, decaySec));
  return buf;
}

describe("addon onset detection", () => {
  it(
    "places a click within a fraction of a millisecond of its true time",
    async () => {
      // Deliberately off both the millisecond and the detector's 0.5 ms bin
      // grid, so only sub-bin refinement can land it accurately.
      const trueSample = 24025;
      const trueSec = trueSample / SR;
      const onsets = await onsetsOf([makeImpulse(1.0, trueSample)]);
      const events = onsets.filter((o) => o.salience >= SALIENCE_FLOOR);

      expect(events.length).toBe(1);
      expect(Math.abs(events[0].timeSec - trueSec)).toBeLessThan(0.0002);
    },
    TIMEOUT,
  );

  it(
    "finds one onset per hat and none inside the decays",
    async () => {
      const hits = [0.2, 0.7, 1.2];
      const onsets = await onsetsOf([makeHatPattern(1.6, hits)]);
      const events = onsets.filter((o) => o.salience >= SALIENCE_FLOOR);

      expect(events.length).toBe(hits.length);
      for (let i = 0; i < hits.length; i++) {
        // Never early, and inside the attack: a broadband burst cannot be
        // localized more tightly than the analysis takes to register it.
        expect(events[i].timeSec - hits[i]).toBeGreaterThan(0);
        expect(events[i].timeSec - hits[i]).toBeLessThan(0.005);
      }
    },
    TIMEOUT,
  );

  it(
    "keeps a vibrato tone below the level of a real hit",
    async () => {
      // A sustained tone whose pitch wobbles ±1 semitone at 5 Hz, windowed so
      // its own start and end are not events. Plain spectral flux rises on
      // every upward glide; the max filter over neighbouring bands is what
      // makes the glides read as movement rather than as new hits.
      const durationSec = 2.0;
      const buf = silence(durationSec);
      const fade = Math.round(0.2 * SR);
      let phase = 0;
      for (let i = 0; i < buf.length; i++) {
        const t = i / SR;
        const freq = 440 * Math.pow(2, Math.sin(2 * Math.PI * 5 * t) / 12);
        phase += (2 * Math.PI * freq) / SR;
        const window = Math.min(1, i / fade, (buf.length - 1 - i) / fade);
        buf[i] = 0.5 * window * Math.sin(phase);
      }
      const onsets = await onsetsOf([buf]);
      const running = onsets.filter((o) => o.timeSec > 0.25 && o.timeSec < durationSec - 0.25);

      expect(running.every((o) => o.salience < SALIENCE_FLOOR)).toBe(true);
    },
    TIMEOUT,
  );

  it(
    "detects a tone that fades in with no magnitude transient",
    async () => {
      // 30 ms linear fade-in at 1.0 s: the magnitude ramp is gentle enough that
      // flux alone is marginal, so this is the complex-domain term's case.
      const buf = silence(2.0);
      const start = Math.round(1.0 * SR);
      const fade = Math.round(0.03 * SR);
      for (let i = start; i < buf.length; i++) {
        const gain = Math.min(1, (i - start) / fade);
        buf[i] = 0.5 * gain * Math.sin((2 * Math.PI * 660 * (i - start)) / SR);
      }
      const onsets = await onsetsOf([buf]);
      const events = onsets.filter((o) => o.salience >= SALIENCE_FLOOR);

      // Somewhere between the start of the ramp and its end.
      expect(events.some((o) => o.timeSec >= 0.995 && o.timeSec <= 1.035)).toBe(true);
    },
    TIMEOUT,
  );

  it(
    "returns the same onsets from the synthesis pass, within its time budget",
    async () => {
      // 30 s of hits — long enough that the detection walk is measured against
      // a synthesis of realistic length rather than against startup noise.
      const durationSec = 30;
      const hits: number[] = [];
      for (let t = 0.25; t < durationSec - 0.5; t += 0.5) hits.push(t);
      const analysis = await addon.analyze([makeHatPattern(durationSec, hits, 0.1)], 1, SR, PARAMS);

      const plainStart = performance.now();
      await addon.synthesize(analysis.data, analysis, SR, PARAMS, false, []);
      const plainMs = performance.now() - plainStart;

      const withStart = performance.now();
      const withOnsets = await addon.synthesize(
        analysis.data,
        analysis,
        SR,
        { ...PARAMS, detectOnsets: true },
        false,
        [],
      );
      const withMs = performance.now() - withStart;

      const direct = await addon.detectOnsets(analysis.data, metaOf(analysis), SR);
      expect(withOnsets.onsets).toBeDefined();
      expect(Array.from(withOnsets.onsets as Float32Array)).toEqual(Array.from(direct.onsets));
      expect(unpack(direct.onsets).filter((o) => o.salience >= SALIENCE_FLOOR).length).toBe(hits.length);

      // Budgeted against the audio rather than against synthesis, which is
      // FFT-based and much faster than a per-coefficient walk: detection runs
      // around 1.5 ms per second of audio, so a few hundred milliseconds on a
      // long file. That is why it is requested per call rather than always on.
      expect(withMs - plainMs).toBeLessThan(durationSec * 5);
    },
    TIMEOUT,
  );
});
