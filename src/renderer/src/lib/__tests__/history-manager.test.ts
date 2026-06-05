import { describe, expect, it, vi } from "vitest";

// Mirror the mocks used by managed-files.test.ts so importing history-manager
// doesn't pull the full zustand store (circular init deps outside Electron).
vi.mock("@renderer/effects", () => ({
  effects: { transform: {}, dynamics: {}, blur: {}, overtones: {}, synthesize: {}, passthrough: {} },
}));
vi.mock("@mantine/notifications", () => ({ notifications: { show: vi.fn() } }));
vi.mock("../modals", () => ({
  openConfirm: vi.fn(),
  openContextModal: vi.fn(),
  openNewFilePrompt: vi.fn(),
  openReanalyzePrompt: vi.fn(),
}));
vi.mock("tone", () => ({ Player: class {} }));

// Hoisted so the vi.mock factories (themselves hoisted above the imports) can
// reference these shared stubs without a TDZ error.
const { fakeOpenFiles, synthesizeFile, loadCachedAudio } = vi.hoisted(() => ({
  fakeOpenFiles: {} as Record<string, unknown>,
  synthesizeFile: vi.fn(),
  loadCachedAudio: vi.fn(async () => false),
}));
vi.mock("@renderer/store", () => ({
  useStore: { getState: () => ({ synthesizeFile, loadCachedAudio }) },
}));
vi.mock("@renderer/store/files", () => ({ openFiles: fakeOpenFiles }));

// Silence the renderer→main menu-state IPC the manager fires on every change.
vi.mock("../ipc", () => ({ ipcSend: vi.fn() }));

import { applyDelta, computeDeltaRect, getHistoryManager, PackedStateCache } from "../history-manager";
import type { SpectrogramData } from "../../store/types";

function makeRGBA(width: number, height: number, fill: number): Float32Array {
  const arr = new Float32Array(width * height * 4);
  for (let i = 0; i < arr.length; i++) arr[i] = fill;
  return arr;
}

describe("history-manager codec", () => {
  describe("computeDeltaRect", () => {
    it("returns null when nothing changed", () => {
      const w = 8,
        h = 4;
      const before = makeRGBA(w, h, 0.25);
      const after = new Float32Array(before);
      expect(computeDeltaRect(before, after, w, h)).toBeNull();
    });

    it("picks a 1×1 rect for a single-pixel change", () => {
      const w = 8,
        h = 4;
      const before = makeRGBA(w, h, 0);
      const after = new Float32Array(before);
      const x = 5,
        y = 2;
      const i = (y * w + x) * 4;
      after[i + 0] = 1;
      after[i + 1] = 2;
      after[i + 2] = 3;
      after[i + 3] = 4;
      const diff = computeDeltaRect(before, after, w, h);
      expect(diff).not.toBeNull();
      expect(diff!.rect).toEqual({ x, y, w: 1, h: 1 });
      expect(Array.from(diff!.patch)).toEqual([1, 2, 3, 4]);
    });

    it("bounds multiple changed pixels with a tight rect", () => {
      const w = 8,
        h = 6;
      const before = makeRGBA(w, h, 0);
      const after = new Float32Array(before);
      const write = (x: number, y: number, v: number) => {
        const i = (y * w + x) * 4;
        after[i] = v;
        after[i + 1] = v;
        after[i + 2] = v;
        after[i + 3] = v;
      };
      write(2, 1, 1);
      write(4, 3, 2);
      write(3, 2, 3);
      const diff = computeDeltaRect(before, after, w, h)!;
      expect(diff.rect).toEqual({ x: 2, y: 1, w: 3, h: 3 });
      // Patch value at local (0,0) maps to global (2,1) — value 1.
      expect(diff.patch[0]).toBe(1);
      // Patch value at local (2,2) maps to global (4,3) — value 2.
      const localI = (2 * diff.rect.w + 2) * 4;
      expect(diff.patch[localI]).toBe(2);
    });

    it("detects change in any channel", () => {
      const w = 4,
        h = 4;
      const before = makeRGBA(w, h, 1);
      const after = new Float32Array(before);
      after[(1 * w + 1) * 4 + 3] = 99; // alpha only
      const diff = computeDeltaRect(before, after, w, h)!;
      expect(diff.rect).toEqual({ x: 1, y: 1, w: 1, h: 1 });
      // Patch stores `after - before`: RGB are unchanged (diff 0), alpha jumped
      // from 1 → 99, so the recorded diff is 98.
      expect(diff.patch[0]).toBe(0);
      expect(diff.patch[1]).toBe(0);
      expect(diff.patch[2]).toBe(0);
      expect(diff.patch[3]).toBe(98);
    });

    it("records zero for untouched pixels inside the bounding box", () => {
      // Non-zero base so patch values can be distinguished from 'after'.
      const w = 8,
        h = 4;
      const before = makeRGBA(w, h, 0.5);
      const after = new Float32Array(before);
      // Only the two corners of the bbox actually change.
      const writePixel = (x: number, y: number, v: number) => {
        const i = (y * w + x) * 4;
        after[i] = v;
        after[i + 1] = v;
        after[i + 2] = v;
        after[i + 3] = v;
      };
      writePixel(2, 1, 0.9);
      writePixel(4, 2, 0.1);
      const diff = computeDeltaRect(before, after, w, h)!;
      expect(diff.rect).toEqual({ x: 2, y: 1, w: 3, h: 2 });
      // Middle pixel of the bbox at local (1, 0) → global (3, 1) is untouched.
      // Because we store diffs, its patch entry must be exactly zero.
      const localI = (0 * diff.rect.w + 1) * 4;
      expect(diff.patch[localI]).toBe(0);
      expect(diff.patch[localI + 1]).toBe(0);
      expect(diff.patch[localI + 2]).toBe(0);
      expect(diff.patch[localI + 3]).toBe(0);
    });
  });

  describe("applyDelta", () => {
    it("reproduces the after buffer from before + delta", () => {
      const w = 16,
        h = 8;
      const before = makeRGBA(w, h, 0);
      const after = new Float32Array(before);
      // Scatter some changes in a region.
      for (let y = 2; y < 6; y++) {
        for (let x = 3; x < 11; x++) {
          const i = (y * w + x) * 4;
          after[i] = x + y;
          after[i + 1] = x * 2;
          after[i + 2] = y * 3;
          after[i + 3] = 1;
        }
      }
      const diff = computeDeltaRect(before, after, w, h)!;
      const reconstructed = applyDelta(before, diff.rect, diff.patch, w);
      expect(Array.from(reconstructed)).toEqual(Array.from(after));
    });

    it("does not touch pixels outside the rect", () => {
      const w = 8,
        h = 4;
      const before = makeRGBA(w, h, 0.5);
      const after = new Float32Array(before);
      const i = (1 * w + 1) * 4;
      after[i] = 7;
      const diff = computeDeltaRect(before, after, w, h)!;
      const reconstructed = applyDelta(before, diff.rect, diff.patch, w);
      // Check an arbitrary untouched pixel retained its value.
      const untouched = (3 * w + 6) * 4;
      expect(reconstructed[untouched]).toBe(0.5);
    });

    it("round-trips correctly when base values are non-zero inside the bbox", () => {
      // This is the scenario diff-based deltas are designed to handle: a base
      // with non-zero values, only a few pixels inside the bbox actually
      // change. Reconstruction must equal `after` exactly.
      const w = 10,
        h = 6;
      const before = new Float32Array(w * h * 4);
      for (let p = 0; p < w * h; p++) {
        before[p * 4] = (p % 7) * 0.125; // R
        before[p * 4 + 1] = (p % 5) * 0.25; // G
        before[p * 4 + 2] = ((p * 3) % 11) * 0.0625; // B
        before[p * 4 + 3] = 1;
      }
      const after = new Float32Array(before);
      // Two scattered changes inside a 4×3 bbox.
      const writePixel = (x: number, y: number, r: number) => {
        const i = (y * w + x) * 4;
        after[i] = r;
        after[i + 1] = r + 0.1;
        after[i + 2] = r + 0.2;
        after[i + 3] = r + 0.3;
      };
      writePixel(3, 2, 0.9);
      writePixel(5, 4, 0.4);
      const diff = computeDeltaRect(before, after, w, h)!;
      const reconstructed = applyDelta(before, diff.rect, diff.patch, w);
      expect(Array.from(reconstructed)).toEqual(Array.from(after));
    });
  });
});

describe("PackedStateCache", () => {
  const a = new Float32Array([1, 2, 3, 4]); // 16 bytes each
  const b = new Float32Array([5, 6, 7, 8]);
  const c = new Float32Array([9, 10, 11, 12]);

  it("returns the exact stored array (lossless round-trip)", () => {
    const cache = new PackedStateCache(1024);
    cache.set("a", a);
    expect(cache.get("a")).toBe(a);
  });

  it("evicts least-recently-used entries once over the byte budget", () => {
    const cache = new PackedStateCache(32); // room for 2 of the 16-byte arrays
    cache.set("a", a);
    cache.set("b", b);
    cache.set("c", c); // pushes total to 48 > 32 → oldest ("a") evicted
    expect(cache.has("a")).toBe(false);
    expect(cache.has("b")).toBe(true);
    expect(cache.has("c")).toBe(true);
  });

  it("get() refreshes recency so the touched entry survives eviction", () => {
    const cache = new PackedStateCache(32);
    cache.set("a", a);
    cache.set("b", b);
    cache.get("a"); // "a" is now most-recent, "b" oldest
    cache.set("c", c); // evicts the oldest, which is now "b"
    expect(cache.has("a")).toBe(true);
    expect(cache.has("b")).toBe(false);
    expect(cache.has("c")).toBe(true);
  });

  it("keeps the just-inserted entry even when it alone exceeds the budget", () => {
    const cache = new PackedStateCache(4); // smaller than one 16-byte array
    cache.set("a", a);
    expect(cache.get("a")).toBe(a);
    expect(cache.size).toBe(1);
  });

  it("delete() drops the entry and frees its budget", () => {
    const cache = new PackedStateCache(32);
    cache.set("a", a);
    cache.set("b", b);
    cache.delete("a");
    expect(cache.has("a")).toBe(false);
    cache.set("c", c); // a+b would have been 32; with "a" gone there's room for "c"
    expect(cache.has("b")).toBe(true);
    expect(cache.has("c")).toBe(true);
  });
});

// In-memory window.* shims so the real HistoryManager runs in the browser test
// environment. zstd is faked as identity (byte-preserving) so reconstruction is
// exercised without a native codec; the fs is a path→value map.
function installManagerEnv(): { fbo: { last: Float32Array | null } } {
  // history-manager wraps payloads in Node's Buffer; the browser test runtime
  // has no Buffer, so stand in a byte-compatible Uint8Array factory.
  const g = globalThis as unknown as { Buffer?: unknown };
  if (g.Buffer === undefined) {
    g.Buffer = {
      from: (src: ArrayBuffer | ArrayBufferView | number[], off?: number, len?: number): Uint8Array => {
        if (src instanceof ArrayBuffer) return new Uint8Array(src, off ?? 0, len ?? src.byteLength - (off ?? 0));
        if (ArrayBuffer.isView(src)) return new Uint8Array(src.buffer, src.byteOffset, src.byteLength);
        return new Uint8Array(src);
      },
    };
  }

  const store = new Map<string, string | Uint8Array>();
  const w = window as unknown as Record<string, unknown>;
  w.ipcRenderer = {
    invoke: vi.fn(async (channel: string) => (channel === "get-user-data-path" ? "/userdata" : undefined)),
  };
  w.nodePath = { join: (...parts: string[]) => parts.join("/") };
  w.nodeZlib = {
    zstdCompress: (buf: Uint8Array, cb: (e: Error | null, out: Uint8Array) => void) => cb(null, new Uint8Array(buf)),
    zstdDecompress: (buf: Uint8Array, cb: (e: Error | null, out: Uint8Array) => void) => cb(null, new Uint8Array(buf)),
  };
  w.nodeFs = {
    mkdir: vi.fn(async () => undefined),
    writeFile: vi.fn(async (path: string, data: string | Uint8Array) => {
      store.set(path, typeof data === "string" ? data : new Uint8Array(data));
    }),
    readFile: vi.fn(async (path: string, encoding?: string) => {
      const v = store.get(path);
      if (v === undefined) throw new Error(`ENOENT: ${path}`);
      if (encoding === "utf8") return v as string;
      const bytes = v as Uint8Array;
      return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    }),
    rm: vi.fn(async (path: string) => {
      store.delete(path);
    }),
  };

  const fbo = { last: null as Float32Array | null };
  fakeOpenFiles["f1"] = {
    spectrogramData: {},
    rendererRef: { current: { setFBOData: (d: Float32Array) => (fbo.last = d), reloadTextures: vi.fn() } },
  };
  return { fbo };
}

// A spectrogram whose packed data we control; side-data is unused by within-
// analysis navigation but required by addRootSnapshot.
function makeSpectrogram(packed: Float32Array, w: number, h: number): SpectrogramData {
  return {
    packedData: packed,
    inverseMap: new Float32Array(4),
    metadata: new Float32Array(4),
    textureWidth: w,
    textureHeight: h,
    numFrames: w,
    numBands: h,
    numChannels: 1,
    sampleRate: 44100,
    minFreq: 20,
    bandsPerOctave: 12,
    packedTextureSize: { x: w, y: h },
    synthesisMetadata: {
      bandOffsets: new Uint32Array([0]),
      bandStepLog2s: new Int32Array([0]),
      bandLengths: new Uint32Array([h]),
    },
  } as unknown as SpectrogramData;
}

// Deterministic, deliberately lossy float fill — values like p/97 aren't exactly
// representable, so a delta-subtraction undo would drift from these. The cache
// must return the original bytes regardless.
function lossyFill(w: number, h: number, salt: number): Float32Array {
  const arr = new Float32Array(w * h * 4);
  for (let i = 0; i < arr.length; i++) arr[i] = ((i + salt) % 97) / 97 + salt * 0.013;
  return arr;
}

describe("HistoryManager undo/redo round-trip", () => {
  it("restores the exact painted state across repeated undo/redo (lossless)", async () => {
    const { fbo } = installManagerEnv();
    const w = 6,
      h = 4;
    const root = lossyFill(w, h, 0);
    const a = lossyFill(w, h, 1);
    const b = lossyFill(w, h, 2);
    const dimensions = {
      textureWidth: w,
      textureHeight: h,
      numFrames: w,
      numBands: h,
      numChannels: 1,
      sampleRate: 44100,
      minFreq: 20,
      bandsPerOctave: 12,
    };

    const mgr = getHistoryManager("f1");
    await mgr.addRootSnapshot({ data: root, kind: "root", label: "root", spectrogram: makeSpectrogram(root, w, h) });
    await mgr.addStroke({ data: a, label: "A", dimensions });
    await mgr.addStroke({ data: b, label: "B", dimensions });

    // Bounce up and down the chain many times. Each visited node must come back
    // byte-for-byte identical — a subtractive (delta-inverse) undo would
    // accumulate float error and fail these exact-equality checks.
    for (let cycle = 0; cycle < 5; cycle++) {
      await mgr.navigateToParent(); // B → A
      expect(Array.from(fbo.last!)).toEqual(Array.from(a));
      await mgr.navigateToParent(); // A → root
      expect(Array.from(fbo.last!)).toEqual(Array.from(root));
      await mgr.navigateToLastChild(); // root → A
      expect(Array.from(fbo.last!)).toEqual(Array.from(a));
      await mgr.navigateToLastChild(); // A → B
      expect(Array.from(fbo.last!)).toEqual(Array.from(b));
    }

    mgr.dispose();
    delete fakeOpenFiles["f1"];
  });
});
