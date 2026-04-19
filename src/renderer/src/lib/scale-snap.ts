import { Scale } from "tonal";

export const C0_HZ = 16.3516;

const PC_BY_NAME: Record<string, number> = {
  C: 0,
  "C#": 1,
  Db: 1,
  D: 2,
  "D#": 3,
  Eb: 3,
  E: 4,
  F: 5,
  "F#": 6,
  Gb: 6,
  G: 7,
  "G#": 8,
  Ab: 8,
  A: 9,
  "A#": 10,
  Bb: 10,
  B: 11,
};

export function tonicSemitoneClass(tonic: string): number {
  return PC_BY_NAME[tonic] ?? 0;
}

// Returns 12 signed offsets indexed by ABSOLUTE pitch class (pc=0 is C).
// offsets[pc] = 0 if pc is in the scale, else the signed distance to the nearest in-scale pc
// (preferring upward on ties). Invalid or empty scales produce all-zero offsets.
const offsetsCache = new Map<string, Float32Array>();

export function buildScaleOffsets(tonic: string, type: string): Float32Array {
  const key = `${tonic}|${type}`;
  const cached = offsetsCache.get(key);
  if (cached) return cached;

  const offsets = new Float32Array(12);
  const scale = Scale.get(`${tonic} ${type}`);
  const chromaStr = scale.chroma;
  if (!chromaStr || chromaStr.length !== 12) {
    offsetsCache.set(key, offsets);
    return offsets;
  }
  // Tonal's chroma is relative to the tonic (index 0 = tonic). Rotate to absolute-PC indexing.
  const tonicPc = tonicSemitoneClass(tonic);
  const bits: number[] = new Array(12).fill(0);
  let anyOn = false;
  for (let i = 0; i < 12; i++) {
    if (chromaStr[i] === "1") {
      bits[(i + tonicPc) % 12] = 1;
      anyOn = true;
    }
  }
  if (!anyOn) {
    offsetsCache.set(key, offsets);
    return offsets;
  }

  for (let pc = 0; pc < 12; pc++) {
    if (bits[pc]) {
      offsets[pc] = 0;
      continue;
    }
    let found = false;
    for (let d = 1; d < 12 && !found; d++) {
      if (bits[(pc + d) % 12]) {
        offsets[pc] = d;
        found = true;
      } else if (bits[(pc - d + 12) % 12]) {
        offsets[pc] = -d;
        found = true;
      }
    }
    if (!found) offsets[pc] = 0;
  }

  offsetsCache.set(key, offsets);
  return offsets;
}

// Snap a target pitch (semitones from any consistent reference whose pitch class
// aligns with absolute pitch class, e.g. semis above C0) to the nearest in-scale pitch.
// Considers both floor and ceil chromatic candidates so near-boundary values pick the
// truly-closest scale note.
export function snapSemisToScale(target: number, offsets: Float32Array): number {
  const chromaLow = Math.floor(target);
  const chromaHigh = chromaLow + 1;
  const pcLow = ((chromaLow % 12) + 12) % 12;
  const pcHigh = ((chromaHigh % 12) + 12) % 12;
  const candLow = chromaLow + offsets[pcLow];
  const candHigh = chromaHigh + offsets[pcHigh];
  return Math.abs(candLow - target) <= Math.abs(candHigh - target) ? candLow : candHigh;
}

// Step to the next in-scale pitch in `direction` from `target`. First snaps target to
// scale, then walks chromatic semitones until the next in-scale pitch is found.
export function stepScaleSemis(target: number, direction: 1 | -1, offsets: Float32Array): number {
  const snapped = snapSemisToScale(target, offsets);
  let semi = Math.round(snapped);
  for (let steps = 0; steps < 24; steps++) {
    semi += direction;
    const pc = ((semi % 12) + 12) % 12;
    if (offsets[pc] === 0) return semi;
  }
  return snapped + 12 * direction;
}

// Given a spectrogram minFreq (Hz), the pitch-class-aligned absolute semitone offset of
// the bottom of the spectrogram. Adding a band's "semis above minFreq" yields absSemis,
// whose mod-12 is the absolute pitch class.
export function minFreqSemisAboveC0(minFreq: number): number {
  if (minFreq <= 0) return 0;
  return 12 * Math.log2(minFreq / C0_HZ);
}
