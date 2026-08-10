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
// sensitivity control. Salience is an amplitude: the level the event reaches
// over the quietest the signal got before it. The cases below therefore assert
// on onsets above a fraction of the loudest event in the same file, which is
// what the control does, and on the separation between real events and the
// things that must stay below them.

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
// Fraction of the file's loudest event a peak must reach to count as one,
// standing in for the sensitivity control.
const EVENT_FRACTION = 0.25;

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

/** The onsets a sensitivity setting would keep, as a share of the biggest. */
function events(onsets: Onset[], fraction = EVENT_FRACTION): Onset[] {
  const loudest = onsets.reduce((max, o) => Math.max(max, o.salience), 0);
  return onsets.filter((o) => o.salience >= loudest * fraction);
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

/** A pitch-dropping sine with an exponential decay — a kick. */
function makeKick(durationSec: number, startSec: number, gain: number): Float32Array {
  const buf = silence(durationSec);
  const start = Math.round(startSec * SR);
  let phase = 0;
  for (let i = start; i < buf.length; i++) {
    const t = (i - start) / SR;
    const freq = 45 + 75 * Math.exp(-t / 0.02);
    phase += (2 * Math.PI * freq) / SR;
    buf[i] = gain * Math.exp(-t / 0.12) * Math.sin(phase);
  }
  return buf;
}

function rms(buf: Float32Array, fromSec: number, toSec: number): number {
  let sum = 0;
  let count = 0;
  for (let i = Math.round(fromSec * SR); i < Math.min(buf.length, Math.round(toSec * SR)); i++) {
    sum += buf[i] * buf[i];
    count++;
  }
  return Math.sqrt(sum / Math.max(1, count));
}

describe("addon onset detection", () => {
  it(
    "places a click within a fraction of a millisecond of its true time",
    async () => {
      // Deliberately off both the millisecond and the detector's 0.5 ms bin
      // grid, so only sub-bin refinement can land it accurately.
      const trueSample = 24025;
      const trueSec = trueSample / SR;
      const found = events(await onsetsOf([makeImpulse(1.0, trueSample)]));

      expect(found.length).toBe(1);
      expect(Math.abs(found[0].timeSec - trueSec)).toBeLessThan(0.0002);
    },
    TIMEOUT,
  );

  it(
    "finds one onset per hat and none inside the decays",
    async () => {
      const hits = [0.2, 0.7, 1.2];
      const found = events(await onsetsOf([makeHatPattern(1.6, hits)]));

      expect(found.length).toBe(hits.length);
      for (let i = 0; i < hits.length; i++) {
        // Never early, and inside the attack: a broadband burst cannot be
        // localized more tightly than the analysis takes to register it.
        expect(found[i].timeSec - hits[i]).toBeGreaterThan(0);
        expect(found[i].timeSec - hits[i]).toBeLessThan(0.005);
      }
    },
    TIMEOUT,
  );

  it(
    "ranks a loud low hit above a quiet high one",
    async () => {
      // The bands a kick lives in are sampled hundreds of times more slowly
      // than the ones a hi-hat lives in. Anything measured per unit time is
      // therefore dominated by the hi-hat however quiet it is, and the two have
      // to be compared by the level they reach instead.
      const durationSec = 2.0;
      const buf = silence(durationSec);
      mixInto(buf, makeKick(durationSec, 0.5, 1.0));
      mixInto(buf, makeHat(durationSec, 1.5, 0.05));
      for (let i = Math.round(1.5 * SR); i < buf.length; i++) buf[i] *= 0.08;

      const levelRatio = rms(buf, 0.5, 0.62) / rms(buf, 1.5, 1.62);
      expect(levelRatio).toBeGreaterThan(8);

      const onsets = await onsetsOf([buf]);
      const kick = onsets.find((o) => Math.abs(o.timeSec - 0.5) < 0.02);
      const hat = onsets.find((o) => Math.abs(o.timeSec - 1.5) < 0.02);

      expect(kick).toBeDefined();
      expect(hat).toBeDefined();
      expect((kick as Onset).salience).toBeGreaterThan((hat as Onset).salience * 2);
    },
    TIMEOUT,
  );

  it(
    "reports one event per hit rather than one before it as well",
    async () => {
      // The slowest bands cover a sixth of a second each, so the evidence for a
      // hit is spread over a window starting well before it. Spread as a flat
      // block that window has no highest point and peak picking takes its front
      // edge, which reported a second event a twentieth of a second early — at
      // nearly the same strength, since the level is smeared the same way.
      const onsets = await onsetsOf([makeHatPattern(1.6, [0.2, 0.7, 1.2])]);

      expect(onsets.length).toBe(3);
      expect(events(onsets).length).toBe(3);
    },
    TIMEOUT,
  );

  it(
    "keeps a vibrato tone below the level of a real hit",
    async () => {
      // A sustained tone whose pitch wobbles ±1 semitone at 5 Hz, windowed so
      // its own start and end are not events. Plain spectral flux rises on
      // every upward glide; the max filter over neighbouring bands is what
      // makes the glides read as movement rather than as new hits. A single hat
      // gives the file one real event to be judged against, which is how the
      // sensitivity control sees it — a wobble has to stay well under a hit for
      // any setting to separate them.
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
      const hitSec = 1.0;
      mixInto(buf, makeHat(durationSec, hitSec, 0.08));

      const onsets = await onsetsOf([buf]);
      const hit = onsets.find((o) => Math.abs(o.timeSec - hitSec) < 0.01);
      expect(hit).toBeDefined();

      const wobble = onsets.filter(
        (o) => o.timeSec > 0.25 && o.timeSec < durationSec - 0.25 && Math.abs(o.timeSec - hitSec) >= 0.05,
      );
      for (const o of wobble) expect(o.salience).toBeLessThan((hit as Onset).salience * EVENT_FRACTION);
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
      const found = events(await onsetsOf([buf]));

      // Somewhere between the start of the ramp and its end.
      expect(found.some((o) => o.timeSec >= 0.995 && o.timeSec <= 1.035)).toBe(true);
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
      expect(events(unpack(direct.onsets)).length).toBe(hits.length);

      // Budgeted against the audio rather than against synthesis, which is
      // FFT-based and much faster than a per-coefficient walk: detection runs
      // around 6 ms per second of audio, so a couple of hundred milliseconds on
      // a long file. That is why it is requested per call rather than always on.
      expect(withMs - plainMs).toBeLessThan(durationSec * 5);
    },
    TIMEOUT,
  );
});
