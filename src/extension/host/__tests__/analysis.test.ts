import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { decodeFrame, encodeFrame, type Frame, type NumericArray } from "../../shared/analysis-protocol";
import { decodeRenderBatch, encodeRenderBatch, type RenderedAudio } from "../../shared/render-batch";
import { startEditorServer, type EditorServer } from "../server";

// The native analysis pipeline (ffmpeg + gaborator) is verified to run in Live's
// embedded host by the in-host spike; audio-analysis.ts resolves its addon path
// only from the bundled out-ext/host layout, not from the vitest source tree.
// So these tests cover the transport this slice adds — the binary frame and the
// /analyze endpoint plumbing — with a synthetic spectrogram-shaped frame.

function sampleFrame(): Frame {
  const numBands = 4;
  const data = new Float32Array([0.1, -0.2, 3.5, 4.25, -100.0, 0.0, 1e6, -1e-6]);
  const bandOffsets = new Uint32Array([0, 2, 4, 6]);
  const bandStepLog2s = new Int32Array([-1, 0, 1, 2]);
  const bandLengths = new Uint32Array([2, 2, 2, 2]);
  return {
    meta: { numBands, numFrames: 2, numChannels: 1, textureWidth: 4, textureHeight: 2, format: "wav" },
    arrays: { data, bandOffsets, bandStepLog2s, bandLengths },
  };
}

describe("analysis binary protocol", () => {
  it("round-trips typed arrays and scalar meta byte-for-byte", () => {
    const original = sampleFrame();
    const decoded = decodeFrame(encodeFrame(original).buffer as ArrayBuffer);

    expect(decoded.meta).toEqual(original.meta);
    expect(decoded.arrays.data instanceof Float32Array).toBe(true);
    expect(decoded.arrays.bandOffsets instanceof Uint32Array).toBe(true);
    expect(decoded.arrays.bandStepLog2s instanceof Int32Array).toBe(true);
    expect(Array.from(decoded.arrays.data)).toEqual(Array.from(original.arrays.data));
    expect(Array.from(decoded.arrays.bandStepLog2s)).toEqual(Array.from(original.arrays.bandStepLog2s));
    expect(Array.from(decoded.arrays.bandLengths)).toEqual(Array.from(original.arrays.bandLengths));
  });

  it("classifies typed arrays from a foreign realm (native-addon parity)", () => {
    // The gaborator addon mints its result arrays in its own environment, which
    // in Live's embedded host is a different realm than the host bundle — so
    // `instanceof Float32Array` is false. A vm context reproduces that exact
    // condition: these arrays fail `instanceof` against the outer realm but must
    // still encode as their real kind, not the old i32 fallthrough.
    const ctx = runInNewContext(`({
      data: new Float32Array([0.5, -0.5]),
      bandOffsets: new Uint32Array([0, 1]),
      bandStepLog2s: new Int32Array([-1, 2]),
    })`) as { data: NumericArray; bandOffsets: NumericArray; bandStepLog2s: NumericArray };
    expect(ctx.data instanceof Float32Array).toBe(false);

    const decoded = decodeFrame(encodeFrame({ meta: {}, arrays: { ...ctx } }).buffer as ArrayBuffer);
    expect(decoded.arrays.data instanceof Float32Array).toBe(true);
    expect(decoded.arrays.bandOffsets instanceof Uint32Array).toBe(true);
    expect(decoded.arrays.bandStepLog2s instanceof Int32Array).toBe(true);
    expect(Array.from(decoded.arrays.data)).toEqual([0.5, -0.5]);
  });
});

describe("render batch", () => {
  it("round-trips multiple renders with their channels, sample rate and label", () => {
    const renders: RenderedAudio[] = [
      { channels: [new Float32Array([0.5, -0.25])], sampleRate: 44100, label: "first" },
      {
        channels: [new Float32Array([1, 2, 3]), new Float32Array([-1, -2, -3])],
        sampleRate: 48000,
        label: "second",
      },
    ];
    const decoded = decodeRenderBatch(encodeRenderBatch(renders).buffer as ArrayBuffer);

    expect(decoded).toHaveLength(2);
    expect(decoded[0].label).toBe("first");
    expect(decoded[0].sampleRate).toBe(44100);
    expect(Array.from(decoded[0].channels[0])).toEqual([0.5, -0.25]);
    expect(decoded[1].channels).toHaveLength(2);
    expect(decoded[1].sampleRate).toBe(48000);
    expect(Array.from(decoded[1].channels[1])).toEqual([-1, -2, -3]);
  });
});

describe("/analyze endpoint", () => {
  let webviewDir: string;

  beforeAll(async () => {
    webviewDir = await fs.mkdtemp(join(tmpdir(), "noise-canvas-analyze-"));
    await fs.writeFile(join(webviewDir, "index.html"), "<!doctype html>");
  });

  afterAll(async () => {
    await fs.rm(webviewDir, { recursive: true, force: true });
  });

  it("passes the request through to the injected analyzer and returns its frame intact", async () => {
    const seen: { filePath: string; bandsPerOctave: number; minFreq: number }[] = [];
    const expectedFrame = encodeFrame(sampleFrame());
    const server: EditorServer = await startEditorServer({
      webviewDir,
      analyze: async (filePath, params) => {
        seen.push({ filePath, ...params });
        return expectedFrame;
      },
    });
    try {
      const response = await fetch(`${server.origin}/analyze`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ filePath: "/clips/loop.wav", bandsPerOctave: 24, minFreq: 20 }),
      });
      expect(response.status).toBe(200);
      expect(seen).toEqual([{ filePath: "/clips/loop.wav", bandsPerOctave: 24, minFreq: 20 }]);

      const decoded = decodeFrame(await response.arrayBuffer());
      expect(decoded.meta).toEqual(sampleFrame().meta);
      expect(Array.from(decoded.arrays.data)).toEqual(Array.from(sampleFrame().arrays.data));
    } finally {
      await server.close();
    }
  });

  it("returns 501 when no analyzer is injected", async () => {
    const server = await startEditorServer({ webviewDir });
    try {
      const res = await fetch(`${server.origin}/analyze`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ filePath: "/x.wav", bandsPerOctave: 24, minFreq: 20 }),
      });
      expect(res.status).toBe(501);
    } finally {
      await server.close();
    }
  });

  it("passes a synthesis frame through to the injected synthesizer", async () => {
    const requestSeen: ArrayBuffer[] = [];
    const resultFrame = encodeFrame({
      meta: { peak: 0.5, numChannels: 1 },
      arrays: { channel0: new Float32Array([1, 2, 3]) },
    });
    const server = await startEditorServer({
      webviewDir,
      synthesize: async (request) => {
        requestSeen.push(request);
        return resultFrame;
      },
    });
    try {
      const reqFrame = encodeFrame({ meta: { numChannels: 1 }, arrays: { processedData: new Float32Array([9, 8]) } });
      const response = await fetch(`${server.origin}/synthesize`, { method: "POST", body: reqFrame });
      expect(response.status).toBe(200);
      expect(requestSeen).toHaveLength(1);
      const decoded = decodeFrame(await response.arrayBuffer());
      expect(decoded.meta).toEqual({ peak: 0.5, numChannels: 1 });
      expect(Array.from(decoded.arrays.channel0)).toEqual([1, 2, 3]);
    } finally {
      await server.close();
    }
  });
});
