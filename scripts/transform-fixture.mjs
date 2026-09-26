// Writes a real analysis for the transform comparison tests: six seconds of
// stereo tones off their bands' centres, a chord, a sweep, low noise and a
// click every 0.75 s, analysed by the addon at 44.1 kHz and 24 bands an
// octave. The layout goes to fixture.json and the packed coefficients to
// fixture.bin, both in .cache/transform-golden.
//
// Usage: node scripts/transform-fixture.mjs [--seconds 6]
import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const require = createRequire(import.meta.url);
const addon = require(join(root, "build/Release/gaborator_addon.node"));

const args = process.argv.slice(2);
const at = args.indexOf("--seconds");
const SECONDS = at >= 0 ? Number(args[at + 1]) : 6;
const SAMPLE_RATE = 44100;
const PARAMS = { bandsPerOctave: 24, minFreq: 40 };
const CLICK_EVERY = 0.75;

let seed = 12345;
const random = () => {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed / 2 ** 32 - 0.5;
};

const frames = Math.round(SECONDS * SAMPLE_RATE);
const left = new Float32Array(frames);
const tones = [
  [220.5, 0.2],
  [1333, 0.1],
  [5555, 0.05],
  [11111, 0.03],
  [330, 0.05],
  [415.3, 0.05],
  [493.9, 0.05],
];
for (let i = 0; i < frames; i++) {
  const t = i / SAMPLE_RATE;
  let v = 0;
  for (const [f, a] of tones) v += a * Math.sin(2 * Math.PI * f * t);
  v += 0.05 * Math.sin(2 * Math.PI * (300 * t + (1350 * t * t) / SECONDS));
  v += 0.005 * random();
  left[i] = v;
}
const onsets = [];
for (let t = CLICK_EVERY / 2; t < SECONDS; t += CLICK_EVERY) {
  left[Math.round(t * SAMPLE_RATE)] += 0.8;
  onsets.push(t, 1);
}
const right = new Float32Array(frames);
for (let i = 7; i < frames; i++) right[i] = 0.9 * left[i - 7];

const ar = await addon.analyze([left, right], 2, SAMPLE_RATE, PARAMS);
const dir = join(root, ".cache/transform-golden");
mkdirSync(dir, { recursive: true });
writeFileSync(
  join(dir, "fixture.json"),
  JSON.stringify({
    sampleRate: SAMPLE_RATE,
    bandsPerOctave: PARAMS.bandsPerOctave,
    minFreq: PARAMS.minFreq,
    numFrames: ar.numFrames,
    numBands: ar.numBands,
    texels: ar.texels,
    bandOffsets: Array.from(ar.bandOffsets),
    bandLengths: Array.from(ar.bandLengths),
    bandStepLog2s: Array.from(ar.bandStepLog2s),
    bandFreqsHz: Array.from(ar.bandFreqsHz),
    metadata: Array.from(ar.metadata),
    onsets,
  }),
);
writeFileSync(join(dir, "fixture.bin"), Buffer.from(ar.data.buffer, ar.data.byteOffset, ar.data.byteLength));
console.log(`wrote ${ar.numBands} bands, ${ar.texels} texels, ${(ar.data.byteLength / 1e6).toFixed(1)} MB to ${dir}`);
