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
const { fakeOpenFiles, synthesizeFile, loadCachedAudio, setFileDirty, restoreOnsetsForNode } = vi.hoisted(() => ({
  fakeOpenFiles: {} as Record<string, unknown>,
  synthesizeFile: vi.fn(),
  loadCachedAudio: vi.fn(async () => false),
  setFileDirty: vi.fn(),
  restoreOnsetsForNode: vi.fn(async () => {}),
}));
vi.mock("@renderer/store", () => ({
  useStore: { getState: () => ({ synthesizeFile, loadCachedAudio, setFileDirty, restoreOnsetsForNode }) },
}));
vi.mock("@renderer/store/files", () => ({ openFiles: fakeOpenFiles }));

// Silence the renderer→main menu-state IPC the manager fires on every change.
vi.mock("../ipc", () => ({ ipcSend: vi.fn() }));

import {
  applyFootprintDelta,
  clearAllHistoryManagers,
  decodeFootprintDelta,
  encodeFootprintDelta,
  footprintChanged,
  getHistoryManager,
  PackedStateCache,
} from "../history-manager";
import type { SpectrogramData } from "../../store/types";

function makeRGBA(width: number, height: number, fill: number): Float32Array {
  const arr = new Float32Array(width * height * 4);
  for (let i = 0; i < arr.length; i++) arr[i] = fill;
  return arr;
}

describe("history-manager codec", () => {
  // Flat [start, count, ...] range list from [start, count] pairs.
  const ranges = (...rs: Array<[number, number]>): Uint32Array => new Uint32Array(rs.flat());

  describe("footprintChanged", () => {
    it("is false when the footprint pixels are identical", () => {
      const before = makeRGBA(8, 4, 0.25);
      const after = new Float32Array(before);
      expect(footprintChanged(before, after, ranges([0, 32]))).toBe(false);
    });

    it("is true when any channel inside the footprint differs", () => {
      const before = makeRGBA(8, 4, 0);
      const after = new Float32Array(before);
      after[5 * 4 + 3] = 9; // alpha of pixel 5
      expect(footprintChanged(before, after, ranges([4, 4]))).toBe(true); // pixels 4..7
    });

    it("ignores changes outside the footprint ranges", () => {
      const before = makeRGBA(8, 4, 0);
      const after = new Float32Array(before);
      after[20 * 4] = 1; // pixel 20, outside the range below
      expect(footprintChanged(before, after, ranges([0, 8]))).toBe(false);
    });
  });

  describe("encodeFootprintDelta / applyFootprintDelta", () => {
    it("round-trips after over the footprint", () => {
      const w = 10,
        h = 6;
      const before = new Float32Array(w * h * 4);
      for (let i = 0; i < before.length; i++) before[i] = (i % 13) * 0.1;
      const after = new Float32Array(before);
      for (let p = 12; p < 18; p++) for (let c = 0; c < 4; c++) after[p * 4 + c] = p + c;
      for (let p = 40; p < 45; p++) for (let c = 0; c < 4; c++) after[p * 4 + c] = p * 2 + c;
      const rs = ranges([12, 6], [40, 5]);
      const { ranges: dr, patch } = decodeFootprintDelta(encodeFootprintDelta(after, rs));
      const out = applyFootprintDelta(before, dr, patch);
      expect(Array.from(out)).toEqual(Array.from(after));
    });

    it("leaves pixels outside the ranges untouched", () => {
      const before = makeRGBA(8, 4, 0.5);
      const after = new Float32Array(before);
      after[2 * 4] = 7;
      const rs = ranges([2, 1]);
      const { ranges: dr, patch } = decodeFootprintDelta(encodeFootprintDelta(after, rs));
      const out = applyFootprintDelta(before, dr, patch);
      expect(out[2 * 4]).toBe(7);
      expect(out[20 * 4]).toBe(0.5);
    });

    it("overwrites with exact values, lossless across repeated round-trips", () => {
      // Values like p/97 aren't exactly representable; an additive delta would
      // drift, an overwrite delta must not.
      const before = new Float32Array(64 * 4);
      for (let i = 0; i < before.length; i++) before[i] = (i % 97) / 97;
      const after = new Float32Array(before);
      for (let p = 10; p < 20; p++) for (let c = 0; c < 4; c++) after[p * 4 + c] = ((p * 7 + c) % 91) / 91;
      const rs = ranges([10, 10]);
      const { ranges: dr, patch } = decodeFootprintDelta(encodeFootprintDelta(after, rs));
      let state: Float32Array = before;
      for (let i = 0; i < 5; i++) state = applyFootprintDelta(state, dr, patch);
      expect(Array.from(state)).toEqual(Array.from(after));
    });
  });

  describe("encodeFootprintDelta / decodeFootprintDelta", () => {
    it("round-trips ranges and the footprint values through the binary layout", () => {
      const rs = ranges([3, 2], [40, 5], [100, 1]);
      const before = new Float32Array(200 * 4);
      const after = new Float32Array(before);
      for (let r = 0; r < rs.length; r += 2)
        for (let p = rs[r]; p < rs[r] + rs[r + 1]; p++) for (let c = 0; c < 4; c++) after[p * 4 + c] = p * 4 + c + 1;
      const { ranges: outRanges, patch } = decodeFootprintDelta(encodeFootprintDelta(after, rs));
      expect(Array.from(outRanges)).toEqual(Array.from(rs));
      expect(Array.from(applyFootprintDelta(before, outRanges, patch))).toEqual(Array.from(after));
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

  it("reconstructs a footprint-delta node from disk losslessly", async () => {
    installManagerEnv();
    const w = 8,
      h = 4;
    const root = lossyFill(w, h, 0);
    const a = new Float32Array(root);
    const rs = new Uint32Array([5, 5]); // pixels 5..9
    for (let p = 5; p < 10; p++) for (let c = 0; c < 4; c++) a[p * 4 + c] = ((p * 3 + c) % 89) / 89;
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

    clearAllHistoryManagers();
    const mgr = getHistoryManager("f2");
    await mgr.addRootSnapshot({ data: root, kind: "root", label: "root", spectrogram: makeSpectrogram(root, w, h) });
    const nodeId = await mgr.addStroke({ data: a, label: "A", dimensions, dirtyRanges: rs });
    expect(mgr.getNode(nodeId)?.storage).toBe("delta");

    // Drop in-memory state so reconstruct reads the delta back from disk.
    clearAllHistoryManagers();
    const fresh = getHistoryManager("f2");
    await fresh.initialize();
    const { packedData } = await fresh.reconstruct(nodeId);
    expect(Array.from(packedData)).toEqual(Array.from(a));

    clearAllHistoryManagers();
    delete fakeOpenFiles["f1"];
  });
});

describe("HistoryManager resetToCurrent (purge history)", () => {
  it("collapses to a single root at the current state and keeps undo working", async () => {
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

    clearAllHistoryManagers();
    const mgr = getHistoryManager("f1");
    await mgr.addRootSnapshot({ data: root, kind: "root", label: "root", spectrogram: makeSpectrogram(root, w, h) });
    await mgr.addStroke({ data: a, label: "A", dimensions });
    const bId = await mgr.addStroke({ data: b, label: "B", dimensions });
    expect(mgr.canUndo()).toBe(true);

    await mgr.resetToCurrent();

    // Only the current state survives, as the new root — nothing left to undo to.
    expect(mgr.listNodes().length).toBe(1);
    expect(mgr.getCurrentId()).toBe(bId);
    expect(mgr.canUndo()).toBe(false);
    expect(mgr.canRedo()).toBe(false);
    // The kept root reconstructs to the exact pre-purge state.
    expect(Array.from((await mgr.reconstruct(bId)).packedData)).toEqual(Array.from(b));

    // Painting after a purge records history again, so undo returns to the root
    // — the regression this guards is addStroke throwing on a null manifest.
    const c = lossyFill(w, h, 3);
    await mgr.addStroke({ data: c, label: "C", dimensions });
    expect(mgr.canUndo()).toBe(true);
    await mgr.navigateToParent();
    expect(Array.from(fbo.last!)).toEqual(Array.from(b));

    clearAllHistoryManagers();
    delete fakeOpenFiles["f1"];
  });
});
