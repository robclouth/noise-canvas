/** Longest file Open Raw makes, in seconds. */
export const RAW_MAX_SECONDS = 600;

/** Sample rate of every file Open Raw makes. */
export const RAW_RATE = 48000;

export type RawSampleFormat = "u8" | "s8" | "s16le" | "s16be" | "mulaw" | "topBit";

/** How the playhead moves through the bytes: in order, summed, or held as the bytes say. */
export type RawRead = "plain" | "delta" | "hold";

/**
 * How the samples reach the two channels: one channel, a sample for each
 * channel, a sample placed by a byte of its own, or each sample's bits split
 * into a top and a bottom half.
 */
export type RawStereo = "mono" | "separate" | "pan" | "split";

/** Bytes one sample of each format takes. */
export const RAW_SAMPLE_WIDTH: Record<RawSampleFormat, number> = {
  u8: 1,
  s8: 1,
  s16le: 2,
  s16be: 2,
  mulaw: 1,
  topBit: 1,
};

/** Everything Open Raw needs to turn the first `length` bytes of a file into audio. */
export type RawOpenOptions = {
  length: number;
  format: RawSampleFormat;
  stereo: RawStereo;
  read: RawRead;
  /** Longest a Hold step lasts, in frames. */
  holdLength: number;
  /** Frames of the byte stream each output sample moves on by. */
  speed: number;
  /** Remove Noise strength, 0 (off) to 1. */
  removeNoise: number;
};

/** Channels the result has in each stereo mode. */
export function rawOutputChannels(stereo: RawStereo): number {
  return stereo === "mono" ? 1 : 2;
}

/** Bytes one frame of the stream reads: in "pan", one more for the pan. */
export function rawFrameBytes(format: RawSampleFormat, stereo: RawStereo): number {
  return RAW_SAMPLE_WIDTH[format] * (stereo === "separate" ? 2 : 1) + (stereo === "pan" ? 1 : 0);
}

/** Frames `length` bytes hold. */
export function rawStreamFrames(length: number, format: RawSampleFormat, stereo: RawStereo): number {
  return Math.floor(length / rawFrameBytes(format, stereo));
}

/** Samples a channel of the result holds. Every Read lasts as long as the bytes do played in order at Speed. */
export function rawOutputFrames(options: Pick<RawOpenOptions, "length" | "format" | "stereo" | "speed">): number {
  return Math.floor(rawStreamFrames(options.length, options.format, options.stereo) / options.speed);
}

function decodeMulaw(byte: number): number {
  const u = ~byte & 0xff;
  const t = (((u & 0x0f) << 3) + 0x84) << ((u & 0x70) >> 4);
  return (u & 0x80 ? 0x84 - t : t - 0x84) / 32768;
}

/** The sample at byte `at` in `format`, from −1 to just under 1. */
function sampleAt(bytes: Uint8Array, at: number, format: RawSampleFormat): number {
  switch (format) {
    case "u8":
      return (bytes[at] - 128) / 128;
    case "s8":
      return ((bytes[at] << 24) >> 24) / 128;
    case "s16le":
      return (((bytes[at] | (bytes[at + 1] << 8)) << 16) >> 16) / 32768;
    case "s16be":
      return ((((bytes[at] << 8) | bytes[at + 1]) << 16) >> 16) / 32768;
    case "mulaw":
      return decodeMulaw(bytes[at]);
    case "topBit":
      return bytes[at] & 0x80 ? 1 : -1;
  }
}

/** The top and bottom halves of the sample word at `at`, each centred on 0, into `frame`. */
function splitAt(bytes: Uint8Array, at: number, format: RawSampleFormat, frame: Float64Array): void {
  if (RAW_SAMPLE_WIDTH[format] === 1) {
    frame[0] = ((bytes[at] >> 4) - 7.5) / 7.5;
    frame[1] = ((bytes[at] & 15) - 7.5) / 7.5;
    return;
  }
  const high = format === "s16le" ? bytes[at + 1] : bytes[at];
  const low = format === "s16le" ? bytes[at] : bytes[at + 1];
  frame[0] = (high - 127.5) / 127.5;
  frame[1] = (low - 127.5) / 127.5;
}

/** How much Delta's running sum keeps of itself each frame, so it cannot drift away. */
const DELTA_KEEP = 0.9995;

/**
 * A stream of frames from the bytes, one `next` per frame, writing each
 * frame into `frame`: the samples of each channel, or in "pan" the sample and
 * then its pan from 0 (left) to 1 (right).
 */
function frameStream(bytes: Uint8Array, options: RawOpenOptions, frame: Float64Array): () => void {
  const { format, stereo } = options;
  const width = RAW_SAMPLE_WIDTH[format];
  const frameBytes = rawFrameBytes(format, stereo);
  const frames = rawStreamFrames(bytes.length, format, stereo);
  const summed = stereo === "separate" || stereo === "split" ? 2 : 1;
  const readFrame = (at: number) => {
    switch (stereo) {
      case "separate":
        frame[0] = sampleAt(bytes, at, format);
        frame[1] = sampleAt(bytes, at + width, format);
        return;
      case "split":
        splitAt(bytes, at, format, frame);
        return;
      case "pan":
        frame[0] = sampleAt(bytes, at, format);
        frame[1] = bytes[at + width] / 255;
        return;
      default:
        frame[0] = sampleAt(bytes, at, format);
    }
  };

  switch (options.read) {
    case "plain": {
      let i = 0;
      return () => readFrame((i++ % frames) * frameBytes);
    }
    case "delta": {
      let i = 0;
      const sum = new Float64Array(summed);
      return () => {
        readFrame((i++ % frames) * frameBytes);
        for (let ch = 0; ch < summed; ch++) frame[ch] = sum[ch] = sum[ch] * DELTA_KEEP + frame[ch];
      };
    }
    case "hold": {
      const stepBytes = frameBytes + 1;
      let at = 0;
      let left = 0;
      return () => {
        if (left > 0) {
          left--;
          return;
        }
        if (at + stepBytes > bytes.length) at = 0;
        readFrame(at);
        left = Math.floor((bytes[at + frameBytes] * options.holdLength) / 256);
        at += stepBytes;
      };
    }
  }
}

/**
 * The bytes read as audio at RAW_RATE, one array a channel. Speed resamples
 * the stream by holding each frame, with no smoothing, so slow speeds step.
 */
export function readRawSamples(bytes: Uint8Array, options: RawOpenOptions): Float32Array[] {
  const length = rawOutputFrames({ ...options, length: bytes.length });
  const out = Array.from({ length: rawOutputChannels(options.stereo) }, () => new Float32Array(length));
  if (length === 0) return out;
  const frame = new Float64Array(2);
  const next = frameStream(bytes, options, frame);
  let read = -1;
  for (let k = 0; k < length; k++) {
    const target = Math.floor(k * options.speed);
    while (read < target) {
      next();
      read++;
    }
    switch (options.stereo) {
      case "mono":
        out[0][k] = frame[0];
        break;
      case "pan": {
        const angle = frame[1] * (Math.PI / 2);
        out[0][k] = frame[0] * Math.cos(angle);
        out[1][k] = frame[0] * Math.sin(angle);
        break;
      }
      default:
        out[0][k] = frame[0];
        out[1][k] = frame[1];
    }
  }
  return out;
}

/** Takes out the DC offset in place with a 5 Hz high-pass. */
export function removeRawDc(channels: Float32Array[]): void {
  const keep = 1 - (2 * Math.PI * 5) / RAW_RATE;
  for (const x of channels) {
    let previousIn = 0;
    let previousOut = 0;
    for (let i = 0; i < x.length; i++) {
      const y = x[i] - previousIn + keep * previousOut;
      previousIn = x[i];
      previousOut = y;
      x[i] = y;
    }
  }
}

/** Samples Remove Noise judges at once. */
export const RAW_NOISE_BLOCK = 1024;

const HANN = Float64Array.from(
  { length: RAW_NOISE_BLOCK },
  (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / RAW_NOISE_BLOCK),
);
const TWIDDLE_RE = Float64Array.from({ length: RAW_NOISE_BLOCK / 2 }, (_, j) =>
  Math.cos((-2 * Math.PI * j) / RAW_NOISE_BLOCK),
);
const TWIDDLE_IM = Float64Array.from({ length: RAW_NOISE_BLOCK / 2 }, (_, j) =>
  Math.sin((-2 * Math.PI * j) / RAW_NOISE_BLOCK),
);

function fftInPlace(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let t = re[i];
      re[i] = re[j];
      re[j] = t;
      t = im[i];
      im[i] = im[j];
      im[j] = t;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const half = len >> 1;
    const stride = n / len;
    for (let j = 0; j < half; j++) {
      const wr = TWIDDLE_RE[j * stride];
      const wi = TWIDDLE_IM[j * stride];
      for (let i = j; i < n; i += len) {
        const xr = re[i + half] * wr - im[i + half] * wi;
        const xi = re[i + half] * wi + im[i + half] * wr;
        re[i + half] = re[i] - xr;
        im[i + half] = im[i] - xi;
        re[i] += xr;
        im[i] += xi;
      }
    }
  }
}

/**
 * Spectral flatness of each RAW_NOISE_BLOCK of the channels' mix: about 0.5
 * for hiss, near 0 for tones, steps and silence.
 */
export function rawBlockFlatness(channels: Float32Array[]): Float64Array {
  const length = channels[0]?.length ?? 0;
  const blocks = Math.floor(length / RAW_NOISE_BLOCK);
  const out = new Float64Array(blocks);
  const re = new Float64Array(RAW_NOISE_BLOCK);
  const im = new Float64Array(RAW_NOISE_BLOCK);
  for (let b = 0; b < blocks; b++) {
    const start = b * RAW_NOISE_BLOCK;
    for (let i = 0; i < RAW_NOISE_BLOCK; i++) {
      let mix = 0;
      for (const x of channels) mix += x[start + i];
      re[i] = mix * HANN[i];
      im[i] = 0;
    }
    fftInPlace(re, im);
    let arithmetic = 0;
    let logSum = 0;
    const bins = RAW_NOISE_BLOCK / 2 - 1;
    for (let k = 1; k <= bins; k++) {
      const p = re[k] * re[k] + im[k] * im[k];
      arithmetic += p;
      logSum += Math.log(p + 1e-20);
    }
    arithmetic /= bins;
    out[b] = arithmetic < 1e-12 ? 0 : Math.exp(logSum / bins) / arithmetic;
  }
  return out;
}

/** The flatness above which Remove Noise silences a block, from 0.55 at the lightest strength to 0.25 at full. */
export function rawNoiseThreshold(strength: number): number {
  return 0.55 - 0.3 * strength;
}

/**
 * Silences, in place, every block that sounds like hiss at `strength`, with
 * 2 ms fades. A part block at the end follows the block before it. Returns
 * the share of blocks kept.
 */
export function removeRawNoise(channels: Float32Array[], strength: number): number {
  const flatness = rawBlockFlatness(channels);
  if (flatness.length === 0) return 1;
  const threshold = rawNoiseThreshold(strength);
  const keep = Array.from(flatness, (f) => f <= threshold);
  const step = 1 / Math.round(0.002 * RAW_RATE);
  const length = channels[0].length;
  let gain = keep[0] ? 1 : 0;
  for (let i = 0; i < length; i++) {
    const target = keep[Math.min(keep.length - 1, Math.floor(i / RAW_NOISE_BLOCK))] ? 1 : 0;
    gain += Math.max(-step, Math.min(step, target - gain));
    for (const x of channels) x[i] *= gain;
  }
  return keep.filter(Boolean).length / keep.length;
}

/** Loudness every result is brought to, and the most its peak may then sit over full scale before the limiter. */
const RAW_RMS_DB = -16;
const RAW_PEAK_HEADROOM_DB = 6;

/**
 * Scales the channels in place to a fixed loudness, lifting a sparse result
 * only until its peak sits 6 dB over full scale. Returns false when they are
 * silent.
 */
export function normaliseRaw(channels: Float32Array[]): boolean {
  let sum = 0;
  let count = 0;
  let peak = 0;
  for (const x of channels) {
    for (const v of x) {
      sum += v * v;
      peak = Math.max(peak, Math.abs(v));
    }
    count += x.length;
  }
  if (peak < 1e-9 || count === 0) return false;
  const scale = Math.min(
    Math.pow(10, RAW_RMS_DB / 20) / Math.sqrt(sum / count),
    Math.pow(10, RAW_PEAK_HEADROOM_DB / 20) / peak,
  );
  for (const x of channels) for (let i = 0; i < x.length; i++) x[i] *= scale;
  return true;
}
