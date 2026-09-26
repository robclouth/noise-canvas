/**
 * A neural cellular automaton over a patch of spectrogram, after Mordvintsev et
 * al., "Growing Neural Cellular Automata" (Distill, 2020).
 *
 * The patch is a NCA_GRID × NCA_GRID grid laid over the brush: columns run
 * along time, rows up in pitch. Each cell holds NCA_CHANNELS numbers. The first
 * three are what is heard: the level on a 90 dB scale, and that level carried
 * on the phase as a pair (level·cos, level·sin). The rest are hidden state only
 * the cells read. A step perceives each channel through identity and two Sobel
 * kernels, adds the cell's place in the brush, runs a two-layer network per cell, adds the result to a random half
 * of the cells, and clears every cell with no audible neighbour.
 *
 * The trainer (nca-train.ts) and the shader (nca-step.frag) both follow this
 * file's layout, so a model trained in one runs unchanged in the other.
 */

export const NCA_GRID = 128;
export const NCA_CHANNELS = 12;
export const NCA_VISIBLE = 3;
export const NCA_HIDDEN = 64;
/**
 * Identity, Sobel along time and Sobel along pitch of every channel, then the
 * cell's place in the brush along time and along pitch, each from −1 to 1.
 * Knowing where it sits lets a cell grow its part of the sound without waiting
 * for word to travel in from the brush's edges.
 */
export const NCA_PERCEPTION = NCA_CHANNELS * 3 + 2;
/** Chance a cell applies its update on a given step. */
export const NCA_FIRE_RATE = 0.5;
/** The level scale: 0 is this many dB below full scale, 1 is full scale. */
export const NCA_DB_RANGE = 90;

export type NcaWeights = {
  /** Perception to hidden, `w1[p * NCA_HIDDEN + h]`. */
  w1: Float32Array;
  b1: Float32Array;
  /** Hidden to channel update, `w2[h * NCA_CHANNELS + c]`. */
  w2: Float32Array;
  b2: Float32Array;
};

/** A trained model and what it was trained on, as stored in an effect's parameters. */
export type NcaModel = {
  weights: NcaWeights;
  /** What the model learnt from, for the effect card. */
  label: string;
  /** Mean squared error on the target when training stopped. */
  loss: number;
  iterations: number;
  /**
   * The learnt sound's phase at each grid cell, row-major, quantised to a byte
   * over −π to π. The network learns level only, so this is where a regrown
   * sound gets its own phase back.
   */
  phase: Uint8Array | null;
};

const SIZES = {
  w1: NCA_PERCEPTION * NCA_HIDDEN,
  b1: NCA_HIDDEN,
  w2: NCA_HIDDEN * NCA_CHANNELS,
  b2: NCA_CHANNELS,
};
const TOTAL_WEIGHTS = SIZES.w1 + SIZES.b1 + SIZES.w2 + SIZES.b2;
const FORMAT_VERSION = 2;

/** A phase in radians as the byte NcaModel.phase stores. */
export function quantisePhase(phase: number): number {
  const turn = (phase / (2 * Math.PI) + 0.5) % 1;
  return Math.round((turn < 0 ? turn + 1 : turn) * 256) % 256;
}

/** The phase a byte of NcaModel.phase stands for, in radians. */
export function dequantisePhase(byte: number): number {
  return (byte / 256 - 0.5) * 2 * Math.PI;
}

export function levelOf(magnitude: number): number {
  const db = 20 * Math.log10(Math.max(magnitude, 1e-12));
  return Math.max(1 + db / NCA_DB_RANGE, 0);
}

export function magnitudeOf(level: number): number {
  return level <= 0 ? 0 : Math.pow(10, ((level - 1) * NCA_DB_RANGE) / 20);
}

/** Small random first layer and a silent second one, so an untrained model changes nothing. */
export function initialWeights(random: () => number = Math.random): NcaWeights {
  const w1 = new Float32Array(SIZES.w1);
  const scale = Math.sqrt(2 / NCA_PERCEPTION);
  for (let i = 0; i < w1.length; i++) w1[i] = (random() * 2 - 1) * scale;
  return { w1, b1: new Float32Array(SIZES.b1), w2: new Float32Array(SIZES.w2), b2: new Float32Array(SIZES.b2) };
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

function fromBase64(text: string): Uint8Array {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function serializeModel(model: NcaModel): string {
  const packed = new Float32Array(TOTAL_WEIGHTS);
  let offset = 0;
  for (const key of ["w1", "b1", "w2", "b2"] as const) {
    packed.set(model.weights[key], offset);
    offset += SIZES[key];
  }
  return JSON.stringify({
    version: FORMAT_VERSION,
    grid: NCA_GRID,
    label: model.label,
    loss: model.loss,
    iterations: model.iterations,
    weights: toBase64(new Uint8Array(packed.buffer)),
    phase: model.phase ? toBase64(model.phase) : null,
  });
}

/** The model a parameter holds, or null when it holds none or one this build cannot read. */
export function parseModel(text: unknown): NcaModel | null {
  if (typeof text !== "string" || text.length === 0) return null;
  try {
    const raw = JSON.parse(text) as Record<string, unknown>;
    if (raw.version !== FORMAT_VERSION || raw.grid !== NCA_GRID || typeof raw.weights !== "string") return null;
    const bytes = fromBase64(raw.weights);
    if (bytes.byteLength !== TOTAL_WEIGHTS * 4) return null;
    const packed = new Float32Array(bytes.buffer, bytes.byteOffset, TOTAL_WEIGHTS);
    let offset = 0;
    const take = (n: number) => {
      const slice = packed.slice(offset, offset + n);
      offset += n;
      return slice;
    };
    const weights = { w1: take(SIZES.w1), b1: take(SIZES.b1), w2: take(SIZES.w2), b2: take(SIZES.b2) };
    if (![weights.w1, weights.b1, weights.w2, weights.b2].every((a) => a.every(Number.isFinite))) return null;
    const phase = typeof raw.phase === "string" ? fromBase64(raw.phase) : null;
    return {
      weights,
      phase: phase && phase.length === NCA_GRID * NCA_GRID ? phase : null,
      label: typeof raw.label === "string" ? raw.label : "",
      loss: typeof raw.loss === "number" ? raw.loss : NaN,
      iterations: typeof raw.iterations === "number" ? raw.iterations : 0,
    };
  } catch {
    return null;
  }
}

/**
 * The weights packed for the step shader's float texture: w1, b1, w2, b2 back
 * to back, four to a texel, in a texture NCA_WEIGHT_TEXTURE_WIDTH wide.
 */
export const NCA_WEIGHT_TEXTURE_WIDTH = 256;
export const NCA_WEIGHT_OFFSETS = {
  w1: 0,
  b1: SIZES.w1,
  w2: SIZES.w1 + SIZES.b1,
  b2: SIZES.w1 + SIZES.b1 + SIZES.w2,
};

export function packWeightsForTexture(weights: NcaWeights): { data: Float32Array; width: number; height: number } {
  const texels = Math.ceil(TOTAL_WEIGHTS / 4);
  const width = NCA_WEIGHT_TEXTURE_WIDTH;
  const height = Math.ceil(texels / width);
  const data = new Float32Array(width * height * 4);
  data.set(weights.w1, NCA_WEIGHT_OFFSETS.w1);
  data.set(weights.b1, NCA_WEIGHT_OFFSETS.b1);
  data.set(weights.w2, NCA_WEIGHT_OFFSETS.w2);
  data.set(weights.b2, NCA_WEIGHT_OFFSETS.b2);
  return { data, width, height };
}
