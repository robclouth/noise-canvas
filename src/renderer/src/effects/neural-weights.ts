/**
 * Weights for the Neural effect's network. Each seed grows a different small
 * network, and the network is what decides how the sound behaves, so a seed is
 * the whole character of the effect: the same seed always sounds the same.
 *
 * Layout matches neural-effect.frag: NEURAL_INPUTS perception features feed
 * NEURAL_HIDDEN tanh units, which feed NEURAL_OUTPUTS outputs (level change,
 * phase change). No output bias: the shader subtracts the network's answer on
 * a featureless neighbourhood, which would cancel it anyway.
 */

export const NEURAL_INPUTS = 8;
export const NEURAL_HIDDEN = 8;
export const NEURAL_OUTPUTS = 2;

/** Upper bound on generations per dab; one shader pass is compiled per generation. */
export const NEURAL_MAX_GENERATIONS = 16;

export type NeuralWeights = {
  /** Input to hidden, row-major: `w1[hidden * NEURAL_INPUTS + input]`. */
  w1: Float32Array;
  b1: Float32Array;
  /** Hidden to output, row-major: `w2[output * NEURAL_HIDDEN + hidden]`. */
  w2: Float32Array;
};

/** Mulberry32: a small, well-mixed 32-bit PRNG, so a seed is stable across platforms. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gaussian(random: () => number): number {
  const u = Math.max(random(), 1e-12);
  const v = random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

const cache = new Map<number, NeuralWeights>();

/**
 * The network for a seed. Weights are drawn with variance 1/fan-in, so every
 * seed sits in the same range of activity and Chaos, not the seed, decides how
 * hard the units saturate.
 */
export function neuralWeights(seed: number): NeuralWeights {
  const key = Math.round(seed);
  const cached = cache.get(key);
  if (cached) return cached;

  // Scramble the seed first so neighbouring seeds share no leading draws.
  const random = mulberry32(Math.imul(key ^ 0x9e3779b9, 0x85ebca6b));
  const w1 = new Float32Array(NEURAL_HIDDEN * NEURAL_INPUTS);
  const b1 = new Float32Array(NEURAL_HIDDEN);
  const w2 = new Float32Array(NEURAL_OUTPUTS * NEURAL_HIDDEN);
  const inputScale = 1 / Math.sqrt(NEURAL_INPUTS);
  const hiddenScale = 1 / Math.sqrt(NEURAL_HIDDEN);
  for (let i = 0; i < w1.length; i++) w1[i] = gaussian(random) * inputScale;
  for (let i = 0; i < b1.length; i++) b1[i] = gaussian(random) * 0.5;
  for (let i = 0; i < w2.length; i++) w2[i] = gaussian(random) * hiddenScale;

  const weights = { w1, b1, w2 };
  cache.set(key, weights);
  return weights;
}
