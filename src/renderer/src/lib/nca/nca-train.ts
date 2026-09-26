import * as tf from "@tensorflow/tfjs-core";
import "@tensorflow/tfjs-core/dist/register_all_gradients";
import {
  initialWeights,
  NCA_CHANNELS,
  NCA_FIRE_RATE,
  NCA_GRID,
  NCA_HIDDEN,
  NCA_PERCEPTION,
  NCA_VISIBLE,
  NcaModel,
  NcaWeights,
} from "./nca-model";

export type NcaVariables = { w1: tf.Variable; b1: tf.Variable; w2: tf.Variable; b2: tf.Variable };

/**
 * Identity, Sobel along time and Sobel along pitch for every channel, as a
 * depthwise kernel: output channel c·3 + k is view k of channel c. The time
 * axis is the grid's columns, pitch its rows.
 */
function perceptionKernel(): tf.Tensor4D {
  const data = new Float32Array(3 * 3 * NCA_CHANNELS * 3);
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const views = [dx === 0 && dy === 0 ? 1 : 0, (dx * (2 - Math.abs(dy))) / 8, (dy * (2 - Math.abs(dx))) / 8];
      for (let c = 0; c < NCA_CHANNELS; c++) {
        for (let k = 0; k < 3; k++) {
          data[(((dy + 1) * 3 + (dx + 1)) * NCA_CHANNELS + c) * 3 + k] = views[k];
        }
      }
    }
  }
  return tf.tensor4d(data, [3, 3, NCA_CHANNELS, 3]);
}

/** Each cell's place in the grid, [1, rows, cols, 2]: time then pitch, −1 to 1 at the cell centres. */
function positionField(): tf.Tensor4D {
  const data = new Float32Array(NCA_GRID * NCA_GRID * 2);
  for (let row = 0; row < NCA_GRID; row++) {
    for (let col = 0; col < NCA_GRID; col++) {
      data[(row * NCA_GRID + col) * 2] = ((col + 0.5) / NCA_GRID) * 2 - 1;
      data[(row * NCA_GRID + col) * 2 + 1] = ((row + 0.5) / NCA_GRID) * 2 - 1;
    }
  }
  return tf.tensor4d(data, [1, NCA_GRID, NCA_GRID, 2]);
}

export function createVariables(weights: NcaWeights): NcaVariables {
  return {
    w1: tf.variable(tf.tensor2d(weights.w1, [NCA_PERCEPTION, NCA_HIDDEN])),
    b1: tf.variable(tf.tensor1d(weights.b1)),
    w2: tf.variable(tf.tensor2d(weights.w2, [NCA_HIDDEN, NCA_CHANNELS])),
    b2: tf.variable(tf.tensor1d(weights.b2)),
  };
}

export async function readVariables(vars: NcaVariables): Promise<NcaWeights> {
  const [w1, b1, w2, b2] = await Promise.all([vars.w1.data(), vars.b1.data(), vars.w2.data(), vars.b2.data()]);
  return {
    w1: Float32Array.from(w1),
    b1: Float32Array.from(b1),
    w2: Float32Array.from(w2),
    b2: Float32Array.from(b2),
  };
}

/**
 * One step of the automaton over a batch of grids [batch, rows, cols, channels].
 * `fireMask` picks which cells update; left out, half of them do at random.
 */
export function ncaStep(
  x: tf.Tensor4D,
  vars: NcaVariables,
  kernel: tf.Tensor4D,
  position: tf.Tensor4D,
  fireMask?: tf.Tensor4D,
): tf.Tensor4D {
  return tf.tidy(() => {
    const [batch, rows, cols] = x.shape;
    const views = tf.depthwiseConv2d(x, kernel, 1, "same");
    const perception = tf.concat([views, tf.tile(position, [batch, 1, 1, 1])], 3);
    const flat = tf.reshape(perception, [-1, NCA_PERCEPTION]);
    const hidden = tf.relu(tf.add(tf.matMul(flat, vars.w1), vars.b1));
    const update = tf.reshape(tf.add(tf.matMul(hidden, vars.w2), vars.b2), [batch, rows, cols, NCA_CHANNELS]);
    const fire = fireMask ?? tf.cast(tf.less(tf.randomUniform([batch, rows, cols, 1]), NCA_FIRE_RATE), "float32");
    return tf.add(x, tf.mul(update, fire)) as tf.Tensor4D;
  });
}

const CELLS = NCA_GRID * NCA_GRID;
const STATE_SIZE = CELLS * NCA_CHANNELS;

/**
 * Plants the seed: every hidden channel of the middle cell on. It is silent, so
 * a model that has not yet learnt to grow from it adds nothing to the sound.
 */
export function seedState(into = new Float32Array(STATE_SIZE)): Float32Array {
  const centre = (Math.floor(NCA_GRID / 2) * NCA_GRID + Math.floor(NCA_GRID / 2)) * NCA_CHANNELS;
  for (let c = NCA_VISIBLE; c < NCA_CHANNELS; c++) into[centre + c] = 1;
  return into;
}

/** A state that hears `visible` (NCA_VISIBLE per cell) with no hidden state, plus the seed. */
export function soundState(visible: Float32Array): Float32Array {
  const state = new Float32Array(STATE_SIZE);
  for (let cell = 0; cell < CELLS; cell++) {
    for (let c = 0; c < NCA_VISIBLE; c++) state[cell * NCA_CHANNELS + c] = visible[cell * NCA_VISIBLE + c];
  }
  return seedState(state);
}

function visibleLoss(state: Float32Array, target: Float32Array): number {
  let sum = 0;
  for (let cell = 0; cell < CELLS; cell++) {
    for (let c = 0; c < NCA_VISIBLE; c++) {
      const d = state[cell * NCA_CHANNELS + c] - target[cell * NCA_VISIBLE + c];
      sum += d * d;
    }
  }
  return sum / (CELLS * NCA_VISIBLE);
}

/** Clears every channel inside a random disc, the way the paper damages its lizard. */
function damage(state: Float32Array, random: () => number): void {
  const cx = random() * NCA_GRID;
  const cy = random() * NCA_GRID;
  const radius = NCA_GRID * (0.1 + 0.3 * random());
  for (let row = 0; row < NCA_GRID; row++) {
    for (let col = 0; col < NCA_GRID; col++) {
      if ((col + 0.5 - cx) ** 2 + (row + 0.5 - cy) ** 2 > radius * radius) continue;
      state.fill(0, (row * NCA_GRID + col) * NCA_CHANNELS, (row * NCA_GRID + col + 1) * NCA_CHANNELS);
    }
  }
}

export type NcaTrainOptions = {
  iterations: number;
  batchSize?: number;
  poolSize?: number;
  stepsMin?: number;
  stepsMax?: number;
  learningRate?: number;
  /** Fraction of the run after which the best sample of each batch is damaged. */
  damageFrom?: number;
  random?: () => number;
  /**
   * How much the phase pair counts against the level in the loss. Noisy sound
   * has close to random phase, and weighing it at all pulls the model towards a
   * grey average of everything, so by default only the level is learnt and the
   * phase pair is left to the model as more hidden state.
   */
  phaseWeight?: number;
  /** Starting weights, to carry on training a model instead of starting afresh. */
  initial?: NcaWeights;
};

export type NcaTrainProgress = {
  iteration: number;
  loss: number;
  /** The audible channels of the batch's first grid after this iteration. */
  output: Float32Array;
};

/**
 * Trains a model to grow `target` (NCA_VISIBLE per cell, NCA_GRID square) and
 * to keep it. Starts come from a lone seed, from the sounds in `context` with
 * the seed planted, and from the pool of the model's own earlier results, some
 * of them damaged, so it learns to grow the target out of silence, out of
 * other sound, and back over a hole. Stops early when `signal` aborts, and
 * returns the weights it had reached.
 */
export async function trainNca(
  target: Float32Array,
  context: Float32Array[],
  options: NcaTrainOptions,
  onProgress?: (progress: NcaTrainProgress) => void,
  signal?: AbortSignal,
): Promise<Omit<NcaModel, "label" | "phase">> {
  const random = options.random ?? Math.random;
  const batchSize = options.batchSize ?? 4;
  const poolSize = options.poolSize ?? 64;
  const stepsMin = options.stepsMin ?? 16;
  const stepsMax = options.stepsMax ?? 32;
  const damageFrom = options.damageFrom ?? 0.25;
  const learningRate = options.learningRate ?? 2e-3;
  const phaseWeight = options.phaseWeight ?? 0;

  const vars = createVariables(options.initial ?? initialWeights(random));
  const kernel = perceptionKernel();
  const position = positionField();
  const targetTensor = tf.tensor4d(target, [1, NCA_GRID, NCA_GRID, NCA_VISIBLE]);
  const lossWeights = tf.tensor4d([1, phaseWeight, phaseWeight], [1, 1, 1, NCA_VISIBLE]);
  const optimizer = tf.train.adam(learningRate);
  const pool = Array.from({ length: poolSize }, () => seedState());
  const fresh = (): Float32Array => {
    if (context.length === 0 || random() < 0.5) return seedState();
    const visible = context[Math.floor(random() * context.length)];
    return soundState(visible);
  };

  let loss = NaN;
  let iteration = 0;
  try {
    for (; iteration < options.iterations; iteration++) {
      if (signal?.aborted) break;
      // Past two thirds of the run, smaller steps settle the weights.
      if (iteration === Math.floor(options.iterations * 0.66)) {
        (optimizer as unknown as { learningRate: number }).learningRate = learningRate * 0.1;
      }

      const picks = Array.from({ length: batchSize }, () => Math.floor(random() * poolSize));
      picks.sort((a, b) => visibleLoss(pool[b], target) - visibleLoss(pool[a], target));
      pool[picks[0]] = fresh();
      if (iteration >= options.iterations * damageFrom) {
        const best = pool[picks[picks.length - 1]].slice();
        damage(best, random);
        pool[picks[picks.length - 1]] = best;
      }

      const batch = new Float32Array(batchSize * STATE_SIZE);
      picks.forEach((p, i) => batch.set(pool[p], i * STATE_SIZE));
      const x0 = tf.tensor4d(batch, [batchSize, NCA_GRID, NCA_GRID, NCA_CHANNELS]);
      const steps = stepsMin + Math.floor(random() * (stepsMax - stepsMin + 1));

      let finalState: tf.Tensor4D | null = null;
      const { value, grads } = tf.variableGrads(() => {
        let x = x0;
        for (let s = 0; s < steps; s++) x = ncaStep(x, vars, kernel, position);
        finalState = tf.keep(x);
        const visible = tf.slice(x, [0, 0, 0, 0], [batchSize, NCA_GRID, NCA_GRID, NCA_VISIBLE]);
        return tf.mean(tf.mul(tf.squaredDifference(visible, targetTensor), lossWeights)) as tf.Scalar;
      });
      // Normalising each gradient keeps the long unrolled chain from exploding.
      const normalised = Object.entries(grads).map(([name, grad]) => ({
        name,
        tensor: tf.tidy(() => tf.div(grad, tf.add(tf.norm(grad), 1e-8))),
      }));
      optimizer.applyGradients(normalised);
      loss = (await value.data())[0];

      const result = finalState as tf.Tensor4D | null;
      if (result) {
        const data = await result.data();
        picks.forEach((p, i) => (pool[p] = Float32Array.from(data.subarray(i * STATE_SIZE, (i + 1) * STATE_SIZE))));
        result.dispose();
      }
      tf.dispose([x0, value, ...Object.values(grads), ...normalised.map((n) => n.tensor)]);

      if (onProgress) {
        const first = pool[picks[0]];
        const output = new Float32Array(CELLS * NCA_VISIBLE);
        for (let cell = 0; cell < CELLS; cell++) {
          for (let c = 0; c < NCA_VISIBLE; c++) output[cell * NCA_VISIBLE + c] = first[cell * NCA_CHANNELS + c];
        }
        onProgress({ iteration: iteration + 1, loss, output });
      }
      // Let the interface draw between iterations.
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    return { weights: await readVariables(vars), loss, iterations: iteration };
  } finally {
    tf.dispose([kernel, position, targetTensor, lossWeights, vars.w1, vars.b1, vars.w2, vars.b2]);
    optimizer.dispose();
  }
}

/** Runs a trained model forward from `state` for `steps` steps, every cell firing. */
export async function runNca(state: Float32Array, weights: NcaWeights, steps: number): Promise<Float32Array> {
  const vars = createVariables(weights);
  const kernel = perceptionKernel();
  const position = positionField();
  let x = tf.tensor4d(state, [1, NCA_GRID, NCA_GRID, NCA_CHANNELS]);
  const everyCell = tf.ones([1, NCA_GRID, NCA_GRID, 1]) as tf.Tensor4D;
  for (let s = 0; s < steps; s++) {
    const next = ncaStep(x, vars, kernel, position, everyCell);
    x.dispose();
    x = next;
  }
  const result = Float32Array.from(await x.data());
  tf.dispose([x, kernel, position, everyCell, vars.w1, vars.b1, vars.w2, vars.b2]);
  return result;
}
