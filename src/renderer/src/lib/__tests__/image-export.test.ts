import { WebGLRenderer } from "three";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createMockSpectrogramData } from "../../test/mock-spectrogram";
import { createSpectrogramTextures } from "../../test/render-harness";
import type { SpectrogramData } from "../../store/types";
import { computeAutoRange, computeImageSize, computeTimeTaps, renderSpectrogramPlot } from "../image-export";
import {
  buildColormapLut,
  COLORMAPS,
  colormapAnchors,
  colormapMountColor,
  RANDOM_ANCHOR_COUNT,
  randomColormapAnchors,
} from "../image-export-colormaps";
import { computePosterLayout } from "../image-export-poster";

describe("computeImageSize", () => {
  it("puts the requested size on the long edge for both orientations", () => {
    expect(computeImageSize(1, 4096)).toEqual({ width: 4096, height: 4096 });
    expect(computeImageSize(16 / 9, 4096)).toEqual({ width: 4096, height: 2304 });
    expect(computeImageSize(9 / 16, 4096)).toEqual({ width: 2304, height: 4096 });
  });

  it("keeps both dimensions even", () => {
    const { width, height } = computeImageSize(3 / 2, 2049);
    expect(width % 2).toBe(0);
    expect(height % 2).toBe(0);
  });
});

describe("computeTimeTaps", () => {
  it("asks for one tap per stored bin the pixel covers", () => {
    // Finest band steps by 2^5 = 32 frames, so 2048 frames per pixel is 64 bins.
    const steps = new Int32Array([5, 5, 6, 7]);
    expect(computeTimeTaps(2048 * 100, 100, steps)).toBe(64);
    expect(computeTimeTaps(32 * 4 * 100, 100, steps)).toBe(4);
  });

  it("never drops below one tap or past the shader's clamp", () => {
    const steps = new Int32Array([5]);
    expect(computeTimeTaps(10, 4096, steps)).toBe(1);
    expect(computeTimeTaps(1e9, 16, steps)).toBe(64);
  });
});

describe("computeAutoRange", () => {
  /** A probe readback whose levels follow `levelAt`, as RGBA bytes. */
  function probe(count: number, levelAt: (i: number) => number): Uint8Array {
    const pixels = new Uint8Array(count * 4);
    for (let i = 0; i < count; i++) {
      const level = Math.max(0, Math.min(255, Math.round(levelAt(i))));
      pixels[i * 4] = level;
      pixels[i * 4 + 1] = level;
      pixels[i * 4 + 2] = level;
      pixels[i * 4 + 3] = 255;
    }
    return pixels;
  }

  it("falls back when every pixel is digital silence", () => {
    const range = computeAutoRange(probe(64, () => 0));
    expect(range).toEqual({ minDb: -90, maxDb: -10 });
  });

  it("puts the white point at the loud end and holds a usable span", () => {
    // Levels spread over the top half of the probe span.
    const range = computeAutoRange(probe(1000, (i) => 128 + (i / 1000) * 127));
    expect(range.maxDb).toBeGreaterThan(0);
    expect(range.maxDb - range.minDb).toBeGreaterThanOrEqual(45);
    expect(range.maxDb - range.minDb).toBeLessThanOrEqual(95);
  });

  it("caps the span when the floor is far below the peak", () => {
    // Three quarters near-silent, one quarter loud: the raw gap exceeds the cap.
    const range = computeAutoRange(probe(1000, (i) => (i < 750 ? 1 : 250)));
    expect(range.maxDb - range.minDb).toBeCloseTo(95, 5);
  });
});

describe("buildColormapLut", () => {
  it("ends on the first and last control points", () => {
    const lut = buildColormapLut(["#000000", "#804020", "#ffffff"]);
    expect(lut.length).toBe(256 * 4);
    expect([lut[0], lut[1], lut[2]]).toEqual([0, 0, 0]);
    expect([lut[255 * 4], lut[255 * 4 + 1], lut[255 * 4 + 2]]).toEqual([255, 255, 255]);
  });

  it("rises monotonically in luminance for every shipped ramp", () => {
    for (const map of COLORMAPS.filter((c) => c.anchors.length > 0)) {
      const lut = buildColormapLut(map.anchors);
      const luma = (i: number): number => 0.2126 * lut[i * 4] + 0.7152 * lut[i * 4 + 1] + 0.0722 * lut[i * 4 + 2];
      expect(luma(255)).toBeGreaterThan(luma(0) + 100);
      for (let i = 1; i < 256; i++) {
        expect(luma(i)).toBeGreaterThanOrEqual(luma(i - 1) - 1);
      }
    }
  });
});

describe("randomColormapAnchors", () => {
  const luma = (hex: string): number => {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };

  it("always rises from a near-black floor to a bright peak, however the hue wanders", () => {
    for (let trial = 0; trial < 200; trial++) {
      const anchors = randomColormapAnchors();
      expect(anchors).toHaveLength(RANDOM_ANCHOR_COUNT);
      expect(luma(anchors[0])).toBeLessThan(20);
      expect(luma(anchors[anchors.length - 1])).toBeGreaterThan(180);
      for (let i = 1; i < anchors.length; i++) {
        expect(luma(anchors[i])).toBeGreaterThan(luma(anchors[i - 1]));
      }
    }
  });

  it("visits several distinct hues", () => {
    // Averaged over trials, a wandering path must spread its anchors across the
    // colour wheel rather than sitting in one family.
    let widest = 0;
    for (let trial = 0; trial < 50; trial++) {
      const hues = randomColormapAnchors()
        .map((hex) => {
          const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
          const max = Math.max(r, g, b);
          const min = Math.min(r, g, b);
          if (max === min) return null;
          const d = max - min;
          const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
          return h * 60;
        })
        .filter((h): h is number => h !== null);
      const buckets = new Set(hues.map((h) => Math.floor(h / 60)));
      widest = Math.max(widest, buckets.size);
    }
    expect(widest).toBeGreaterThanOrEqual(4);
  });

  it("draws a different ramp each time", () => {
    const first = randomColormapAnchors().join();
    const second = randomColormapAnchors().join();
    expect(first).not.toEqual(second);
  });

  it("mounts a poster in a dark tint of its own ramp", () => {
    const luminance = (hex: string): number => {
      const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const spread = (hex: string): number => {
      const channels = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
      return Math.max(...channels) - Math.min(...channels);
    };

    for (const id of ["magma", "viridis", "ice", "random"] as const) {
      const mount = colormapMountColor(id);
      // Dark enough to stay a mount, light enough for a shadow to read on it.
      expect(luminance(mount)).toBeGreaterThan(15);
      expect(luminance(mount)).toBeLessThan(70);
      expect(spread(mount)).toBeGreaterThan(4);
    }

    // Ramps with no hue of their own stay neutral.
    expect(spread(colormapMountColor("mono"))).toBe(0);
    expect(spread(colormapMountColor("native"))).toBe(0);
  });

  it("resolves the live ramp for the random id and the fixed one otherwise", () => {
    expect(colormapAnchors("random")).toHaveLength(RANDOM_ANCHOR_COUNT);
    expect(colormapAnchors("native")).toHaveLength(0);
    expect(colormapAnchors("magma")).toEqual(COLORMAPS.find((c) => c.id === "magma")?.anchors);
  });
});

describe("poster layout", () => {
  it("leaves room for the caption under the plot", () => {
    const layout = computePosterLayout(2000, 2000);
    expect(layout.plotX).toBe(layout.margin);
    expect(layout.plotW).toBe(2000 - layout.margin * 2);
    expect(layout.plotY + layout.plotH + layout.captionH).toBe(2000);
  });

  it("scales identically at every output size", () => {
    const small = computePosterLayout(1000, 1000);
    const large = computePosterLayout(4000, 4000);
    expect(large.margin / large.width).toBeCloseTo(small.margin / small.width, 3);
    expect(large.plotH / large.height).toBeCloseTo(small.plotH / small.height, 3);
  });
});

describe("renderSpectrogramPlot", () => {
  let gl: WebGLRenderer;

  beforeEach(() => {
    gl = new WebGLRenderer({ antialias: false });
    gl.setSize(64, 64);
  });

  afterEach(() => {
    gl.dispose();
  });

  function makeSource(data: SpectrogramData) {
    const { packedDataTex, metadataTex } = createSpectrogramTextures(data);
    return { texture: packedDataTex, metadataTexture: metadataTex, spectrogramData: data };
  }

  function pixelAt(canvas: HTMLCanvasElement, x: number, y: number): Uint8ClampedArray {
    return canvas.getContext("2d")!.getImageData(x, y, 1, 1).data;
  }

  const luma = (p: Uint8ClampedArray): number => 0.2126 * p[0] + 0.7152 * p[1] + 0.0722 * p[2];

  it("renders at the requested size", async () => {
    const data = createMockSpectrogramData({ numFrames: 128, numBands: 32, pattern: "gradient" });
    const canvas = await renderSpectrogramPlot(gl, makeSource(data), 96, 48, "magma");
    expect(canvas.width).toBe(96);
    expect(canvas.height).toBe(48);
  });

  it("maps time left to right", async () => {
    // The gradient pattern rises in magnitude with time.
    const data = createMockSpectrogramData({ numFrames: 128, numBands: 32, pattern: "gradient" });
    const canvas = await renderSpectrogramPlot(gl, makeSource(data), 64, 64, "mono");
    expect(luma(pixelAt(canvas, 60, 32))).toBeGreaterThan(luma(pixelAt(canvas, 4, 32)) + 40);
  });

  it("puts low frequencies at the bottom", async () => {
    // bandGradient is brightest at the last band, which is the lowest frequency.
    const data = createMockSpectrogramData({ numFrames: 128, numBands: 32, pattern: "bandGradient" });
    const canvas = await renderSpectrogramPlot(gl, makeSource(data), 64, 64, "mono");
    expect(luma(pixelAt(canvas, 32, 60))).toBeGreaterThan(luma(pixelAt(canvas, 32, 4)) + 40);
  });

  it("keeps mono grey in editor colours and tints it through a ramp", async () => {
    const data = createMockSpectrogramData({ numFrames: 128, numBands: 32, numChannels: 1, pattern: "gradient" });
    const source = makeSource(data);

    const editor = await renderSpectrogramPlot(gl, source, 64, 64, "native");
    const grey = pixelAt(editor, 48, 32);
    // Dither moves a channel by at most one code value.
    expect(Math.abs(grey[0] - grey[1])).toBeLessThanOrEqual(2);
    expect(Math.abs(grey[1] - grey[2])).toBeLessThanOrEqual(2);

    const magma = await renderSpectrogramPlot(gl, source, 64, 64, "magma");
    const warm = pixelAt(magma, 48, 32);
    expect(warm[0]).toBeGreaterThan(warm[2] + 20);
  });
});
