import { asF32, decodeFrame, encodeFrame } from "./analysis-protocol";

// A batch of rendered audio the webview sends back for the host to import into
// Live: one entry for a single "Save to Live", many for a branch export. Each
// entry is an analysis frame (channel0..N + sampleRate/label meta); the batch
// concatenates them behind a count and per-entry length.
//
// Wire format: [u32 count][ [u32 frameLen][frame bytes] ...]

export interface RenderedAudio {
  channels: Float32Array[];
  sampleRate: number;
  label: string;
}

export function encodeRenderBatch(renders: RenderedAudio[]): Uint8Array<ArrayBuffer> {
  const frames = renders.map((render) => {
    const arrays: Record<string, Float32Array> = {};
    render.channels.forEach((channel, i) => (arrays[`channel${i}`] = channel));
    return encodeFrame({
      meta: { sampleRate: render.sampleRate, numChannels: render.channels.length, label: render.label },
      arrays,
    });
  });

  let total = 4;
  for (const frame of frames) total += 4 + frame.byteLength;

  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  view.setUint32(0, frames.length, true);
  let offset = 4;
  for (const frame of frames) {
    view.setUint32(offset, frame.byteLength, true);
    offset += 4;
    out.set(frame, offset);
    offset += frame.byteLength;
  }
  return out;
}

export function decodeRenderBatch(buffer: ArrayBuffer): RenderedAudio[] {
  const view = new DataView(buffer);
  const count = view.getUint32(0, true);
  const renders: RenderedAudio[] = [];
  let offset = 4;
  for (let i = 0; i < count; i++) {
    const frameLen = view.getUint32(offset, true);
    offset += 4;
    const { meta, arrays } = decodeFrame(buffer.slice(offset, offset + frameLen));
    offset += frameLen;
    const numChannels = Number(meta.numChannels);
    const channels = Array.from({ length: numChannels }, (_, c) => asF32(arrays[`channel${c}`], `channel${c}`));
    renders.push({ channels, sampleRate: Number(meta.sampleRate), label: String(meta.label) });
  }
  return renders;
}
