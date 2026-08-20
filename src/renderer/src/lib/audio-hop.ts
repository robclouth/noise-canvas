/** A file's per-state audio readings that travel with its buffer. */
export interface AudioStateMeta {
  peak: number;
  gainReductionDb?: Float32Array;
  maxGainReductionDb?: number;
}

/**
 * The audio a stroke commit changed: the samples of the rewritten span before
 * and after it, per channel, with each side's readings. Undo writes `before`
 * back, redo writes `after`; nothing outside the span differs between the two.
 */
export interface AudioHop {
  start: number;
  end: number;
  before: Float32Array[];
  after: Float32Array[];
  beforeMeta: AudioStateMeta;
  afterMeta: AudioStateMeta;
}

/** One span of samples to write into a buffer, per channel. */
export interface AudioEdit {
  start: number;
  channels: Float32Array[];
}

/** Bytes a hop holds, for the in-memory budget. */
export function audioHopBytes(hop: AudioHop): number {
  let bytes = 0;
  for (const channel of hop.before) bytes += channel.byteLength;
  for (const channel of hop.after) bytes += channel.byteLength;
  bytes += hop.beforeMeta.gainReductionDb?.byteLength ?? 0;
  bytes += hop.afterMeta.gainReductionDb?.byteLength ?? 0;
  return bytes;
}

/**
 * Cuts a hop out of the audio around a commit. `existing` and `result` are
 * whole-file channels; only the window's samples are copied.
 */
export function buildAudioHop(opts: {
  existing: Float32Array[];
  result: Float32Array[];
  start: number;
  end: number;
  beforeMeta: AudioStateMeta;
  afterMeta: AudioStateMeta;
}): AudioHop | null {
  const { existing, result, beforeMeta, afterMeta } = opts;
  if (existing.length !== result.length || existing.length === 0) return null;
  const length = result[0].length;
  const start = Math.max(0, Math.min(length, Math.floor(opts.start)));
  const end = Math.max(start, Math.min(length, Math.ceil(opts.end)));
  for (const channel of existing) if (channel.length !== length) return null;
  return {
    start,
    end,
    before: existing.map((channel) => channel.slice(start, end)),
    after: result.map((channel) => channel.slice(start, end)),
    beforeMeta,
    afterMeta,
  };
}

/**
 * Writes each edit into the channels in order, so a later edit wins where two
 * overlap. Returns the span all of them touched, or null when there were none.
 */
export function applyAudioEdits(channels: Float32Array[], edits: AudioEdit[]): { start: number; end: number } | null {
  let start = Number.POSITIVE_INFINITY;
  let end = 0;
  for (const edit of edits) {
    for (let ch = 0; ch < channels.length; ch++) {
      const source = edit.channels[ch];
      if (!source) continue;
      const count = Math.min(source.length, channels[ch].length - edit.start);
      if (count <= 0) continue;
      channels[ch].set(count === source.length ? source : source.subarray(0, count), edit.start);
      start = Math.min(start, edit.start);
      end = Math.max(end, edit.start + count);
    }
  }
  return end > start ? { start, end } : null;
}

/**
 * The edits that carry a buffer from one history state to another: each hop
 * up to a parent writes its `before`, each hop down to a child its `after`,
 * in walking order. The last hop's readings describe the state arrived at.
 */
export function editsAlongHops(up: AudioHop[], down: AudioHop[]): { edits: AudioEdit[]; meta: AudioStateMeta } | null {
  const edits: AudioEdit[] = [];
  let meta: AudioStateMeta | null = null;
  for (const hop of up) {
    edits.push({ start: hop.start, channels: hop.before });
    meta = hop.beforeMeta;
  }
  for (const hop of down) {
    edits.push({ start: hop.start, channels: hop.after });
    meta = hop.afterMeta;
  }
  return meta ? { edits, meta } : null;
}
