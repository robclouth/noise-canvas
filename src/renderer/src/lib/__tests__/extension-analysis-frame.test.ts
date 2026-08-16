import { describe, expect, it } from "vitest";

import { decodeFrame, encodeFrame, type NumericArray } from "../../../../extension/shared/analysis-protocol";

import hostSource from "../../../../extension/host/analysis-service.ts?raw";
import clientSource from "../host/extension-analysis.ts?raw";

/**
 * The whole-file synthesis round trip in the extension has to carry the onset
 * reference the pass measured. Dropped, the client can never establish
 * `file.onsetReference`, so every later stroke falls back to a whole-file onset
 * walk instead of reading only the span it touched.
 */
describe("extension synthesis frame", () => {
  it("round-trips the onset reference through the frame codec", () => {
    const onsetBandMax = new Float32Array([0.25, 0.5, 0.75]);
    const arrays: Record<string, NumericArray> = {
      channel0: new Float32Array([0, 1]),
      gainReductionDb: new Float32Array([0]),
      onsets: new Float32Array([1, 2]),
      onsetBandMax,
    };

    const encoded = encodeFrame({
      meta: { peak: 1, numChannels: 1, maxGainReductionDb: 0, onsetOdfMax: 0.9 },
      arrays,
    });
    const { meta, arrays: out } = decodeFrame(
      encoded.buffer.slice(encoded.byteOffset, encoded.byteOffset + encoded.byteLength) as ArrayBuffer,
    );

    expect(Number(meta.onsetOdfMax)).toBeCloseTo(0.9, 6);
    expect(Array.from(out.onsetBandMax)).toEqual(Array.from(onsetBandMax));
  });

  it("encodes the onset reference on the host and reads it on the client", () => {
    // Both halves of the /synthesize contract, checked where they are written.
    expect(hostSource).toContain("channels.onsetBandMax = result.onsetBandMax");
    expect(hostSource).toContain("onsetOdfMax: result.onsetOdfMax");
    expect(clientSource).toContain("onsetOdfMax: outMeta.onsetOdfMax");
    expect(clientSource).toContain("onsetBandMax: outArrays.onsetBandMax");
  });
});
