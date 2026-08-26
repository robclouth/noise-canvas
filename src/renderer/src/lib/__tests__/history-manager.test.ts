import { beforeEach, describe, expect, it, vi } from "vitest";

// Mirror the mocks used by managed-files.test.ts so importing history-manager
// doesn't pull the full zustand store (circular init deps outside Electron).
vi.mock("@renderer/effects", () => ({
  effects: { transform: {}, dynamics: {}, blur: {}, synthesize: {}, passthrough: {} },
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
const {
  fakeOpenFiles,
  synthesizeFile,
  loadCachedAudio,
  setFileDirty,
  restoreOnsetsForNode,
  spliceFileAudio,
  awaitFileSynthesis,
} = vi.hoisted(() => ({
  fakeOpenFiles: {} as Record<string, unknown>,
  synthesizeFile: vi.fn(),
  loadCachedAudio: vi.fn(async () => false),
  setFileDirty: vi.fn(),
  restoreOnsetsForNode: vi.fn(async () => {}),
  spliceFileAudio: vi.fn(async () => true),
  awaitFileSynthesis: vi.fn(async (fileId: string): Promise<void> => void fileId),
}));
vi.mock("@renderer/store", () => ({
  useStore: {
    getState: () => ({ synthesizeFile, loadCachedAudio, setFileDirty, restoreOnsetsForNode, spliceFileAudio }),
  },
}));
vi.mock("@renderer/store/files", () => ({
  openFiles: fakeOpenFiles,
  awaitFileSynthesis: (fileId: string) => awaitFileSynthesis(fileId),
}));

// Silence the renderer→main menu-state IPC the manager fires on every change.
vi.mock("../ipc", () => ({ ipcSend: vi.fn() }));

import {
  clearAllHistoryManagers,
  destroyHistoryManager,
  getHistoryManager,
  PackedStateCache,
} from "../history-manager";
import { getBlockStore } from "../block-stores";
import { historyCacheBudgets } from "../history-cache-budgets";
import { serializeFileTask } from "../file-task-queue";
import { canvasPatchStashCount, setCanvasPatchStash } from "../canvas-patch-stash";
import { gatherPixelRanges, scatterCompactPixelRanges } from "../pixel-ranges";
import type { AudioHop } from "../audio-hop";
import type { PhaseTurns } from "../../../../main/lib/types";
import { applyPhaseTurns } from "../../../../main/lib/history-delta";
import type { SpectrogramData } from "../../store/types";

describe("historyCacheBudgets", () => {
  const GIB = 1024 ** 3;
  const MIB = 1024 ** 2;

  it("gives the full budgets from 16 GiB up", () => {
    expect(historyCacheBudgets(16 * GIB)).toEqual({ packedStates: 256 * MIB, deltas: 128 * MIB, audioHops: 256 * MIB });
    expect(historyCacheBudgets(64 * GIB)).toEqual(historyCacheBudgets(16 * GIB));
  });

  it("gives a quarter of the budgets at 8 GiB and below", () => {
    expect(historyCacheBudgets(8 * GIB)).toEqual({ packedStates: 64 * MIB, deltas: 32 * MIB, audioHops: 64 * MIB });
    expect(historyCacheBudgets(4 * GIB)).toEqual(historyCacheBudgets(8 * GIB));
  });

  it("scales in proportion between", () => {
    const budgets = historyCacheBudgets(12 * GIB);
    expect(budgets.packedStates).toBe(160 * MIB);
    expect(budgets.deltas).toBe(80 * MIB);
    expect(budgets.audioHops).toBe(160 * MIB);
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

/**
 * Stand-in for the addon's history codec, which is native and so unavailable in
 * the browser test environment. It is deliberately the simplest thing that round-
 * trips — no reordering, deltas as plain footprint copies — because what these
 * tests check is the manager's plumbing: that each node is rebuilt from the right
 * base, off the right file. The real codec's losslessness is covered against the
 * addon itself in src/main/lib/__tests__/history-codec.test.ts.
 */
function footprintIndices(ranges: Uint32Array): number[] {
  const indices: number[] = [];
  for (let r = 0; r < ranges.length; r += 2) {
    for (let p = ranges[r]; p < ranges[r] + ranges[r + 1]; p++) {
      for (let c = 0; c < 4; c++) indices.push(p * 4 + c);
    }
  }
  return indices;
}

function applyFakeDelta(out: Float32Array, bytes: Uint8Array, invert: boolean): void {
  const blob = new Uint32Array(bytes.slice().buffer);
  const rangeCount = blob[0];
  const ranges = new Uint32Array(Array.from(blob.subarray(1, 1 + rangeCount)));
  const indices = footprintIndices(ranges);
  const diffs = blob.subarray(1 + rangeCount, 1 + rangeCount + indices.length);
  const bits = new Uint32Array(out.buffer, out.byteOffset, out.length);
  indices.forEach((dst, i) => {
    bits[dst] = (invert ? bits[dst] - diffs[i] : bits[dst] + diffs[i]) >>> 0;
  });
  let at = 1 + rangeCount + indices.length;
  const turnCount = blob[at++] ?? 0;
  if (!turnCount) return;
  const f = new Float32Array(1);
  const u = new Uint32Array(f.buffer);
  const turns: PhaseTurns = {
    pixelStarts: new Uint32Array(turnCount),
    pixelCounts: new Uint32Array(turnCount),
    offsets: new Float32Array(turnCount * 2),
    residuals: new Uint32Array(0),
  };
  for (let i = 0; i < turnCount; i++) {
    turns.pixelStarts[i] = blob[at++];
    turns.pixelCounts[i] = blob[at++];
    u[0] = blob[at++];
    turns.offsets[i * 2] = f[0];
    u[0] = blob[at++];
    turns.offsets[i * 2 + 1] = f[0];
  }
  const residualCount = blob[at++];
  turns.residuals = new Uint32Array(Array.from(blob.subarray(at, at + residualCount)));
  applyPhaseTurns(out, turns, invert);
}

function fakeHistoryCodec(): Record<string, unknown> {
  const bytesOf = (a: Float32Array): Uint8Array => new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
  const footprint = footprintIndices;

  return {
    encodeHistorySnapshot: async (packed: Float32Array) => new Uint8Array(bytesOf(packed)),
    decodeHistorySnapshot: async (bytes: Uint8Array) => new Float32Array(bytes.slice().buffer),
    // Either state is whole, or with its compact flag just the footprint's
    // values in range order.
    historyFootprintChanged: async (
      base: Float32Array,
      after: Float32Array,
      ranges: Uint32Array,
      baseCompact = false,
      afterCompact = false,
    ) => footprint(ranges).some((dst, i) => base[baseCompact ? i : dst] !== after[afterCompact ? i : dst]),
    // Like the addon, the delta stores each footprint value as the integer
    // difference of its bit pattern, so adding and subtracting are exact.
    encodeHistoryDelta: async (
      base: Float32Array,
      after: Float32Array,
      ranges: Uint32Array,
      baseCompact = false,
      afterCompact = false,
      turns?: PhaseTurns,
    ) => {
      const indices = footprint(ranges);
      const turnWords = turns ? 1 + turns.pixelStarts.length * 4 + 1 + turns.residuals.length : 1;
      const out = new Uint32Array(1 + ranges.length + indices.length + turnWords);
      out[0] = ranges.length;
      out.set(ranges, 1);
      const baseBits = new Uint32Array(base.buffer, base.byteOffset, base.length);
      const afterBits = new Uint32Array(after.buffer, after.byteOffset, after.length);
      indices.forEach(
        (dst, i) =>
          (out[1 + ranges.length + i] = (afterBits[afterCompact ? i : dst] - baseBits[baseCompact ? i : dst]) >>> 0),
      );
      let at = 1 + ranges.length + indices.length;
      out[at++] = turns ? turns.pixelStarts.length : 0;
      if (turns) {
        const f = new Float32Array(1);
        const u = new Uint32Array(f.buffer);
        for (let i = 0; i < turns.pixelStarts.length; i++) {
          out[at++] = turns.pixelStarts[i];
          out[at++] = turns.pixelCounts[i];
          f[0] = turns.offsets[i * 2];
          out[at++] = u[0];
          f[0] = turns.offsets[i * 2 + 1];
          out[at++] = u[0];
        }
        out[at++] = turns.residuals.length;
        out.set(turns.residuals, at);
      }
      return new Uint8Array(out.buffer);
    },
    applyHistoryDelta: async (base: Float32Array, bytes: Uint8Array) => {
      const out = new Float32Array(base);
      applyFakeDelta(out, bytes, false);
      return out;
    },
    applyHistoryDeltas: async (base: Float32Array, out: Float32Array, deltas: Uint8Array[], inverts: boolean[]) => {
      if (out !== base) out.set(base);
      deltas.forEach((bytes, i) => applyFakeDelta(out, bytes, inverts[i]));
      return out;
    },
    applyHistoryDeltasWindowed: async (
      values: Float32Array,
      table: Uint32Array,
      deltas: Uint8Array[],
      inverts: boolean[],
      totalPixels: number,
    ) => {
      const whole = new Float32Array(totalPixels * 4);
      scatterCompactPixelRanges(whole, values, table);
      deltas.forEach((bytes, i) => applyFakeDelta(whole, bytes, inverts[i]));
      values.set(gatherPixelRanges(whole, table));
      return values;
    },
    readHistoryDeltaTurns: async () => null,
    buildHistoryInverseMap: async (
      _bandOffsets: Uint32Array,
      _bandLengths: Uint32Array,
      _bandStepLog2s: Int32Array,
      pixelCount: number,
    ) => new Float32Array(pixelCount * 2),
  };
}

// In-memory window.* shims so the real HistoryManager runs in the browser test
// environment. zstd is faked as identity (byte-preserving) so reconstruction is
// exercised without a native codec; the fs is a path→value map.
function installManagerEnv(): { fbo: { last: Float32Array | null }; files: Map<string, string | Uint8Array> } {
  // history-manager wraps payloads in Node's Buffer; the browser test runtime
  // has no Buffer, so stand in a byte-compatible Uint8Array factory.
  const g = globalThis as unknown as { Buffer?: unknown };
  if (g.Buffer === undefined) {
    // A function, not a plain object: error serialisers probe `x instanceof
    // Buffer`, which throws on a non-callable stand-in.
    function stub(): void {
      return undefined;
    }
    g.Buffer = Object.assign(stub, {
      from: (src: ArrayBuffer | ArrayBufferView | number[], off?: number, len?: number): Uint8Array => {
        if (src instanceof ArrayBuffer) return new Uint8Array(src, off ?? 0, len ?? src.byteLength - (off ?? 0));
        if (ArrayBuffer.isView(src)) return new Uint8Array(src.buffer, src.byteOffset, src.byteLength);
        return new Uint8Array(src);
      },
    });
  }

  const store = new Map<string, string | Uint8Array>();
  const w = window as unknown as Record<string, unknown>;
  w.ipcRenderer = {
    invoke: vi.fn(async (channel: string) => (channel === "get-user-data-path" ? "/userdata" : undefined)),
  };
  w.nodePath = { join: (...parts: string[]) => parts.join("/") };
  w.nodeOs = { homedir: () => "/home", totalmem: () => 16 * 1024 ** 3 };
  w.nodeZlib = {
    zstdCompress: (buf: Uint8Array, cb: (e: Error | null, out: Uint8Array) => void) => cb(null, new Uint8Array(buf)),
    zstdDecompress: (buf: Uint8Array, cb: (e: Error | null, out: Uint8Array) => void) => cb(null, new Uint8Array(buf)),
  };
  w.audioAnalysis = fakeHistoryCodec();
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
      // A directory holds its files as prefixed keys, the way a recursive rm sees them.
      for (const key of [...store.keys()]) {
        if (key.startsWith(`${path}/`)) store.delete(key);
      }
    }),
    access: vi.fn(async (path: string) => {
      if (store.has(path)) return;
      for (const key of store.keys()) {
        if (key.startsWith(`${path}/`)) return;
      }
      throw new Error(`ENOENT: ${path}`);
    }),
    readdir: vi.fn(async (path: string) => {
      const names = new Set<string>();
      for (const key of store.keys()) {
        if (key.startsWith(`${path}/`)) names.add(key.slice(path.length + 1).split("/")[0]);
      }
      if (names.size === 0) throw new Error(`ENOENT: ${path}`);
      return [...names];
    }),
    stat: vi.fn(async (path: string) => {
      const v = store.get(path);
      if (v !== undefined) {
        return { size: typeof v === "string" ? v.length : v.byteLength, isDirectory: () => false, isFile: () => true };
      }
      for (const key of store.keys()) {
        if (key.startsWith(`${path}/`)) return { size: 0, isDirectory: () => true, isFile: () => false };
      }
      throw new Error(`ENOENT: ${path}`);
    }),
  };

  const fbo = { last: null as Float32Array | null };
  fakeOpenFiles["f1"] = {
    spectrogramData: {},
    rendererRef: { current: { setFBOData: (d: Float32Array) => (fbo.last = d), reloadTextures: vi.fn() } },
  };
  return { fbo, files: store };
}

// A spectrogram whose packed data we control, laid out one band per texture row
// so its band layout and metadata are self-consistent — the manager rebuilds
// both from the manifest, so a nonsense layout wouldn't exercise that.
function makeSpectrogram(packed: Float32Array, w: number, h: number): SpectrogramData {
  const bandOffsets = new Uint32Array(h);
  const bandLengths = new Uint32Array(h);
  const bandStepLog2s = new Int32Array(h);
  const metadata = new Float32Array(h * 4);
  const inverseMap = new Float32Array(w * h * 2);
  for (let band = 0; band < h; band++) {
    bandOffsets[band] = band * w;
    bandLengths[band] = w;
    bandStepLog2s[band] = 0;
    metadata[band * 4] = band * w;
    metadata[band * 4 + 1] = w;
    metadata[band * 4 + 2] = 0;
    metadata[band * 4 + 3] = 100 * (band + 1);
    for (let i = 0; i < w; i++) {
      inverseMap[(band * w + i) * 2] = i;
      inverseMap[(band * w + i) * 2 + 1] = band;
    }
  }
  return {
    packedData: packed,
    inverseMap,
    metadata,
    textureWidth: w,
    textureHeight: h,
    numFrames: w,
    numBands: h,
    numChannels: 1,
    sampleRate: 44100,
    minFreq: 20,
    bandsPerOctave: 12,
    packedTextureSize: { x: w, y: h },
    synthesisMetadata: { bandOffsets, bandStepLog2s, bandLengths },
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

/**
 * A renderer that records partial uploads, as the real one receives them,
 * over a simulated canvas the turns and patches act on.
 */
function installPatchRenderer(
  w: number,
  h: number,
  spectrogram?: SpectrogramData,
): {
  patches: { data: Float32Array; ranges: Uint32Array }[];
  full: Float32Array[];
  turns: number[][];
  canvas: Float32Array;
  file: { spectrogramData: SpectrogramData };
} {
  const patches: { data: Float32Array; ranges: Uint32Array }[] = [];
  const full: Float32Array[] = [];
  const turns: number[][] = [];
  const canvas = new Float32Array(w * h * 4);
  const file = {
    spectrogramData: spectrogram ?? makeSpectrogram(new Float32Array(w * h * 4), w, h),
    audioBuffer: {},
    rendererRef: {
      current: {
        setFBOData: (d: Float32Array) => {
          full.push(d);
          canvas.set(d);
        },
        patchFBOData: (d: Float32Array, r: Uint32Array) => {
          patches.push({ data: d, ranges: r });
          for (let i = 0; i + 1 < r.length; i += 2) canvas.set(d.subarray(r[i] * 4, (r[i] + r[i + 1]) * 4), r[i] * 4);
        },
        applyPhaseTurns: (flat: ArrayLike<number>) => {
          turns.push(Array.from(flat));
          for (let i = 0; i + 3 < flat.length; i += 4) {
            for (let p = flat[i]; p < flat[i] + flat[i + 1]; p++) {
              if (flat[i + 2] !== 0) canvas[p * 4 + 1] = Math.fround(canvas[p * 4 + 1] + flat[i + 2]);
              if (flat[i + 3] !== 0) canvas[p * 4 + 3] = Math.fround(canvas[p * 4 + 3] + flat[i + 3]);
            }
          }
        },
        readPixelRanges: async (r: Uint32Array) => {
          let n = 0;
          for (let i = 1; i < r.length; i += 2) n += r[i];
          const out = new Float32Array(n * 4);
          let at = 0;
          for (let i = 0; i + 1 < r.length; i += 2) {
            out.set(canvas.subarray(r[i] * 4, (r[i] + r[i + 1]) * 4), at);
            at += r[i + 1] * 4;
          }
          return out;
        },
        expandDirtyRegion: vi.fn(),
        reloadTextures: vi.fn(),
      },
    },
  };
  fakeOpenFiles["f1"] = file;
  return { patches, full, turns, canvas, file };
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
    const { id: nodeId } = await mgr.addStroke({ data: a, label: "A", dimensions, dirtyRanges: rs });
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

  it("keeps the root as blocks, not as its own snapshot file", async () => {
    const { files } = installManagerEnv();
    const w = 8,
      h = 4;
    const root = lossyFill(w, h, 0);
    const a = new Float32Array(root);
    const rs = new Uint32Array([5, 5]);
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
    const mgr = getHistoryManager("f3");
    const rootId = await mgr.addRootSnapshot({
      data: root,
      kind: "root",
      label: "root",
      spectrogram: makeSpectrogram(root, w, h),
    });
    await mgr.addStroke({ data: a, label: "A", dimensions, dirtyRanges: rs });

    expect(files.has(`/userdata/history/f3/${rootId}.packed.zst`)).toBe(false);
    expect([...files.keys()].some((path) => path.startsWith("/userdata/blocks/f3/"))).toBe(true);

    // A fresh manager reads the root back from the blocks, byte-identical.
    clearAllHistoryManagers();
    const fresh = getHistoryManager("f3");
    await fresh.initialize();
    const { packedData } = await fresh.reconstruct(rootId);
    expect(Array.from(packedData)).toEqual(Array.from(root));
    clearAllHistoryManagers();
  });

  it("reads a root that an older history wrote as its own snapshot file", async () => {
    const { files } = installManagerEnv();
    const w = 8,
      h = 4;
    const root = lossyFill(w, h, 0);

    clearAllHistoryManagers();
    const mgr = getHistoryManager("f4");
    const rootId = await mgr.addRootSnapshot({
      data: root,
      kind: "root",
      label: "root",
      spectrogram: makeSpectrogram(root, w, h),
    });

    // Rewrite the layout the way histories before the block store left it: the
    // root as one snapshot file, no blocks. The codec is identity in this env.
    const blocks = [...files.keys()].filter((path) => path.startsWith("/userdata/blocks/f4/"));
    expect(blocks.length).toBeGreaterThan(0);
    files.set(`/userdata/history/f4/${rootId}.packed.zst`, new Uint8Array(new Float32Array(root).buffer));
    for (const path of blocks) files.delete(path);

    clearAllHistoryManagers();
    const fresh = getHistoryManager("f4");
    await fresh.initialize();
    const { packedData } = await fresh.reconstruct(rootId);
    expect(Array.from(packedData)).toEqual(Array.from(root));
    clearAllHistoryManagers();
  });

  it("deletes a file's blocks when its history is destroyed", async () => {
    const { files } = installManagerEnv();
    const w = 8,
      h = 4;
    const root = lossyFill(w, h, 0);

    clearAllHistoryManagers();
    const mgr = getHistoryManager("f5");
    await mgr.addRootSnapshot({ data: root, kind: "root", label: "root", spectrogram: makeSpectrogram(root, w, h) });
    expect([...files.keys()].some((path) => path.startsWith("/userdata/blocks/f5/"))).toBe(true);

    await destroyHistoryManager("f5");
    expect([...files.keys()].some((path) => path.startsWith("/userdata/blocks/f5/"))).toBe(false);
  });

  it("reads the root from under a patched store", async () => {
    installManagerEnv();
    const w = 8,
      h = 4;
    const root = lossyFill(w, h, 0);

    clearAllHistoryManagers();
    const mgr = getHistoryManager("f7");
    const rootId = await mgr.addRootSnapshot({
      data: root,
      kind: "root",
      label: "root",
      spectrogram: makeSpectrogram(root, w, h),
    });

    const open = getBlockStore("f7");
    expect(open).not.toBeNull();
    const store = await open!;
    const ranges = new Uint32Array([5, 5]);
    await store.patch(
      ranges,
      gatherPixelRanges(root, ranges).map((value) => value + 1),
    );
    await store.flush();

    clearAllHistoryManagers();
    const fresh = getHistoryManager("f7");
    await fresh.initialize();
    const { packedData } = await fresh.reconstruct(rootId);
    expect(Array.from(packedData)).toEqual(Array.from(root));
    clearAllHistoryManagers();
  });

  it("weighs the overlay's blocks in the file's disk usage", async () => {
    const { files } = installManagerEnv();
    const w = 8,
      h = 4;
    const root = lossyFill(w, h, 0);

    clearAllHistoryManagers();
    const mgr = getHistoryManager("f6");
    await mgr.addRootSnapshot({ data: root, kind: "root", label: "root", spectrogram: makeSpectrogram(root, w, h) });
    const before = await mgr.getDiskUsageBytes();
    expect(before).toBeGreaterThan(0);

    files.set("/userdata/blocks/f6/current/0.blk", new Uint8Array(64));
    expect((await mgr.getDiskUsageBytes()) - before).toBe(64);
    clearAllHistoryManagers();
  });

  it("puts the file's unprojected paint back with the state it belongs to", async () => {
    installManagerEnv();
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
    const file = fakeOpenFiles["f1"] as { unprojectedPaint?: boolean };

    clearAllHistoryManagers();
    const mgr = getHistoryManager("f1");
    await mgr.addRootSnapshot({ data: root, kind: "root", label: "root", spectrogram: makeSpectrogram(root, w, h) });
    // A painted with re-analysis off, then B the stroke that settled the file.
    await mgr.addStroke({ data: a, label: "A", dimensions, unprojectedPaint: true });
    await mgr.addStroke({ data: b, label: "B", dimensions, unprojectedPaint: false });

    await mgr.navigateToParent(); // B → A
    expect(file.unprojectedPaint).toBe(true);
    await mgr.navigateToParent(); // A → root
    expect(file.unprojectedPaint).toBe(false);
    await mgr.navigateToLastChild(); // root → A
    expect(file.unprojectedPaint).toBe(true);
    await mgr.navigateToLastChild(); // A → B
    expect(file.unprojectedPaint).toBe(false);

    clearAllHistoryManagers();
    delete fakeOpenFiles["f1"];
  });

  it("leaves the state's own answer when a stroke changes nothing", async () => {
    installManagerEnv();
    const w = 8,
      h = 4;
    const root = lossyFill(w, h, 0);
    const a = new Float32Array(root);
    const rs = new Uint32Array([5, 5]);
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
    const file = fakeOpenFiles["f1"] as { unprojectedPaint?: boolean };

    clearAllHistoryManagers();
    const mgr = getHistoryManager("f1");
    await mgr.addRootSnapshot({ data: root, kind: "root", label: "root", spectrogram: makeSpectrogram(root, w, h) });
    await mgr.addStroke({ data: a, label: "A", dimensions, dirtyRanges: rs, unprojectedPaint: false });

    // The canvas is still A's, so a stroke that painted nothing cannot make it
    // hold unprojected paint.
    file.unprojectedPaint = true;
    const outcome = await mgr.addStroke({
      data: new Float32Array(a),
      label: "B",
      dimensions,
      dirtyRanges: rs,
      unprojectedPaint: true,
    });
    expect(outcome.isNew).toBe(false);
    expect(file.unprojectedPaint).toBe(false);

    clearAllHistoryManagers();
    delete fakeOpenFiles["f1"];
  });
});

describe("HistoryManager hops", () => {
  const w = 8;
  const h = 4;
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

  /** Paints pixels `start..start+count` of `base` with a lossy fill keyed by `salt`. */
  function paint(base: Float32Array, start: number, count: number, salt: number): Float32Array {
    const out = new Float32Array(base);
    for (let p = start; p < start + count; p++) {
      for (let c = 0; c < 4; c++) out[p * 4 + c] = ((p * 7 + c + salt) % 89) / 89 + salt * 0.011;
    }
    return out;
  }

  // Whole-array mismatches are asserted through this index rather than a
  // toEqual, whose failure diff over huge arrays wedges the browser runner.
  function firstDifference(a: Float32Array, b: Float32Array): number {
    if (a.length !== b.length) return Math.min(a.length, b.length);
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return i;
    return -1;
  }

  it("keeps the store's current tier in step with a committed stroke", async () => {
    const { files } = installManagerEnv();
    clearAllHistoryManagers();
    const root = lossyFill(w, h, 0);
    const a = paint(root, 2, 3, 1);

    const mgr = getHistoryManager("f1");
    await mgr.addRootSnapshot({ data: root, kind: "root", label: "root", spectrogram: makeSpectrogram(root, w, h) });
    const { id } = await mgr.addStroke({ data: a, label: "A", dimensions, dirtyRanges: new Uint32Array([2, 3]) });

    const open = getBlockStore("f1");
    expect(open).not.toBeNull();
    const store = await open!;
    expect(Array.from(await store.readAll())).toEqual(Array.from(a));
    expect(Array.from(await store.readAllRoot())).toEqual(Array.from(root));
    const manifest = JSON.parse(files.get("/userdata/history/f1/tree.json") as string) as { overlayNodeId?: string };
    expect(manifest.overlayNodeId).toBe(id);
    clearAllHistoryManagers();
  });

  it("reseeds the current tier for a stroke whose base it does not hold", async () => {
    installManagerEnv();
    installPatchRenderer(w, h);
    clearAllHistoryManagers();
    const root = lossyFill(w, h, 0);
    const a = paint(root, 2, 3, 1);

    const mgr = getHistoryManager("f1");
    const rootId = await mgr.addRootSnapshot({
      data: root,
      kind: "root",
      label: "root",
      spectrogram: makeSpectrogram(root, w, h),
    });
    await mgr.addStroke({ data: a, label: "A", dimensions, dirtyRanges: new Uint32Array([2, 3]) });
    await mgr.navigateTo(rootId);

    const b = paint(root, 5, 2, 2);
    await mgr.addStroke({ data: b, label: "B", dimensions, dirtyRanges: new Uint32Array([5, 2]) });

    const open = getBlockStore("f1");
    expect(open).not.toBeNull();
    const store = await open!;
    // Pixels 2..4 hold the root's values again, not the undone stroke's.
    expect(Array.from(await store.readAll())).toEqual(Array.from(b));
    expect(Array.from(await store.readAllRoot())).toEqual(Array.from(root));
    clearAllHistoryManagers();
  });

  it("builds on the tier it kept across a relaunch instead of rewriting it", async () => {
    installManagerEnv();
    clearAllHistoryManagers();
    const wide = 20000;
    const bands = 2;
    const wideDims = {
      textureWidth: wide,
      textureHeight: bands,
      numFrames: wide,
      numBands: bands,
      numChannels: 1,
      sampleRate: 8000,
      minFreq: 20,
      bandsPerOctave: 12,
    };
    const root = lossyFill(wide, bands, 0);
    const a = paint(root, 2, 3, 1);
    const spectrogram = { ...makeSpectrogram(root, wide, bands), sampleRate: 8000 };

    const mgr = getHistoryManager("f1");
    await mgr.addRootSnapshot({ data: root, kind: "root", label: "root", spectrogram });
    await mgr.addStroke({ data: a, label: "A", dimensions: wideDims, dirtyRanges: new Uint32Array([2, 3]) });

    clearAllHistoryManagers();
    const fresh = getHistoryManager("f1");
    expect(await fresh.loadSpectrogramAtCurrent()).not.toBeNull();

    const overlayWrites = (): number =>
      (
        window as unknown as { nodeFs: { writeFile: { mock: { calls: [string][] } } } }
      ).nodeFs.writeFile.mock.calls.filter(([path]) => path.startsWith("/userdata/blocks/f1/current/")).length;
    const before = overlayWrites();
    const b = paint(a, 5, 2, 2);
    await fresh.addStroke({ data: b, label: "B", dimensions: wideDims, dirtyRanges: new Uint32Array([5, 2]) });

    const open = getBlockStore("f1");
    expect(open).not.toBeNull();
    const store = await open!;
    expect(store.grid.blockCount).toBeGreaterThan(1);
    // One block under the stroke was patched; the rest of the tier was kept.
    expect(overlayWrites() - before).toBe(1);
    expect(firstDifference(await store.readAll(), b)).toBe(-1);
    expect(firstDifference(await store.readAllRoot(), root)).toBe(-1);
    clearAllHistoryManagers();
  });

  it("serves the current state from the blocks, byte for byte, while the marker stands", async () => {
    const { files } = installManagerEnv();
    installPatchRenderer(w, h);
    clearAllHistoryManagers();
    const root = lossyFill(w, h, 0);
    const a = paint(root, 2, 3, 1);

    const mgr = getHistoryManager("f1");
    await mgr.addRootSnapshot({ data: root, kind: "root", label: "root", spectrogram: makeSpectrogram(root, w, h) });
    await mgr.addStroke({ data: a, label: "A", dimensions, dirtyRanges: new Uint32Array([2, 3]) });
    expect(Array.from((await mgr.currentBlockState())!)).toEqual(Array.from(mgr.currentPackedState()!));

    await mgr.navigateToParent();
    expect(Array.from((await mgr.currentBlockState())!)).toEqual(Array.from(mgr.currentPackedState()!));

    // A marker naming another node means the blocks cannot serve the state.
    clearAllHistoryManagers();
    const treePath = "/userdata/history/f1/tree.json";
    const parsed = JSON.parse(files.get(treePath) as string) as { overlayNodeId?: string };
    parsed.overlayNodeId = "someone-else";
    files.set(treePath, JSON.stringify(parsed));
    const fresh = getHistoryManager("f1");
    expect(await fresh.currentBlockState()).toBeNull();
    clearAllHistoryManagers();
    delete fakeOpenFiles["f1"];
  });

  it("invalidates the tier on disk before it rewrites it", async () => {
    const { files } = installManagerEnv();
    clearAllHistoryManagers();
    const root = lossyFill(w, h, 0);
    const a = paint(root, 2, 3, 1);

    const mgr = getHistoryManager("f1");
    await mgr.addRootSnapshot({ data: root, kind: "root", label: "root", spectrogram: makeSpectrogram(root, w, h) });

    // Record what the on-disk manifest claims at the moment each tier write lands.
    const nodeFs = (window as unknown as { nodeFs: { writeFile: (p: string, d: unknown) => Promise<void> } }).nodeFs;
    const realWriteFile = nodeFs.writeFile;
    const seen: (string | undefined)[] = [];
    nodeFs.writeFile = async (path: string, data: unknown) => {
      if (path.startsWith("/userdata/blocks/f1/current/")) {
        const tree = files.get("/userdata/history/f1/tree.json");
        seen.push(tree ? (JSON.parse(tree as string) as { overlayNodeId?: string }).overlayNodeId : "missing");
      }
      return realWriteFile(path, data);
    };
    await mgr.addStroke({ data: a, label: "A", dimensions, dirtyRanges: new Uint32Array([2, 3]) });
    nodeFs.writeFile = realWriteFile;

    expect(seen).toEqual([undefined]);
    clearAllHistoryManagers();
  });

  it("patches the tier along an undo hop instead of leaving it behind", async () => {
    installManagerEnv();
    const wide = 20000;
    const bands = 2;
    const wideDims = {
      textureWidth: wide,
      textureHeight: bands,
      numFrames: wide,
      numBands: bands,
      numChannels: 1,
      sampleRate: 8000,
      minFreq: 20,
      bandsPerOctave: 12,
    };
    const root = lossyFill(wide, bands, 0);
    const spectrogram = { ...makeSpectrogram(root, wide, bands), sampleRate: 8000 };
    installPatchRenderer(wide, bands, spectrogram);
    clearAllHistoryManagers();
    const a = paint(root, 2, 3, 1);

    const mgr = getHistoryManager("f1");
    await mgr.addRootSnapshot({ data: root, kind: "root", label: "root", spectrogram });
    await mgr.addStroke({ data: a, label: "A", dimensions: wideDims, dirtyRanges: new Uint32Array([2, 3]) });

    const overlayWrites = (): number =>
      (
        window as unknown as { nodeFs: { writeFile: { mock: { calls: [string][] } } } }
      ).nodeFs.writeFile.mock.calls.filter(([path]) => path.startsWith("/userdata/blocks/f1/current/")).length;
    const beforeNav = overlayWrites();
    await mgr.navigateToParent();

    const open = getBlockStore("f1");
    expect(open).not.toBeNull();
    const store = await open!;
    expect(store.grid.blockCount).toBeGreaterThan(1);
    expect(overlayWrites() - beforeNav).toBe(1);
    expect(firstDifference(await store.readAll(), root)).toBe(-1);

    // A stroke from here builds on the tier the hop kept current.
    const beforeStroke = overlayWrites();
    const c = paint(root, 5, 2, 3);
    await mgr.addStroke({ data: c, label: "C", dimensions: wideDims, dirtyRanges: new Uint32Array([5, 2]) });
    expect(overlayWrites() - beforeStroke).toBe(1);
    expect(firstDifference(await store.readAll(), c)).toBe(-1);
    clearAllHistoryManagers();
    delete fakeOpenFiles["f1"];
  });

  it("serves the current state's pixels from the tier, and nothing when the tier is stale", async () => {
    installManagerEnv();
    const { canvas } = installPatchRenderer(w, h);
    clearAllHistoryManagers();
    const root = lossyFill(w, h, 0);
    const mgr = getHistoryManager("f1", { packedCacheBytes: 0 });
    await mgr.addRootSnapshot({ data: root, kind: "root", label: "root", spectrogram: makeSpectrogram(root, w, h) });
    const current = mgr.currentPackedState()!;
    canvas.set(current);

    const ranges = new Uint32Array([4, 4]);
    const baseFootprint = current.slice(4 * 4, 8 * 4);
    for (let p = 4; p < 8; p++) for (let c = 0; c < 4; c++) current[p * 4 + c] = ((p * 5 + c) % 23) / 23;
    canvas.set(current);
    await mgr.addStroke({ data: current, label: "A", dimensions, dirtyRanges: ranges, baseFootprint });

    const probe = new Uint32Array([2, 8, 12, 3]);
    const served = await mgr.currentRanges(probe);
    expect(served).not.toBeNull();
    expect(Array.from(served!)).toEqual(Array.from(gatherPixelRanges(current, probe)));

    mgr.getManifest()!.overlayNodeId = undefined;
    expect(await mgr.currentRanges(probe)).toBeNull();

    mgr.dispose();
    delete fakeOpenFiles["f1"];
  });

  it("derives the tier's hop patch from the deltas, agreeing with the packed state", async () => {
    installManagerEnv();
    const { canvas } = installPatchRenderer(w, h);
    clearAllHistoryManagers();
    const warn = vi.spyOn(console, "warn");
    try {
      const root = lossyFill(w, h, 0);
      for (let p = 8; p < w * h; p++) {
        root[p * 4 + 1] = Math.fround(1e5 + p);
        root[p * 4 + 3] = Math.fround(-1e5 - p);
      }
      const mgr = getHistoryManager("f1", { packedCacheBytes: 0 });
      await mgr.addRootSnapshot({ data: root, kind: "root", label: "root", spectrogram: makeSpectrogram(root, w, h) });
      const current = mgr.currentPackedState()!;
      const rootBytes = new Float32Array(current);
      canvas.set(current);

      const ranges = new Uint32Array([4, 4]);
      const baseFootprint = current.slice(4 * 4, 8 * 4);
      for (let p = 4; p < 8; p++) for (let c = 0; c < 4; c++) current[p * 4 + c] = ((p * 7 + c) % 29) / 29;
      const turns: PhaseTurns = {
        pixelStarts: Uint32Array.from([8]),
        pixelCounts: Uint32Array.from([w * h - 8]),
        offsets: Float32Array.from([Math.fround(2 * Math.PI), 0]),
        residuals: new Uint32Array(0),
      };
      applyPhaseTurns(current, turns, false);
      canvas.set(current);
      await mgr.addStroke({ data: current, label: "A", dimensions, dirtyRanges: ranges, baseFootprint, turns });
      const strokeBytes = new Float32Array(current);
      const store = await getBlockStore("f1")!;

      await mgr.navigateToParent();
      expect(Array.from(await store.readAll())).toEqual(Array.from(rootBytes));
      await mgr.navigateToLastChild();
      expect(Array.from(await store.readAll())).toEqual(Array.from(strokeBytes));
      expect(warn.mock.calls.filter((call) => String(call[0]).includes("tier's delta walk"))).toEqual([]);

      mgr.dispose();
      delete fakeOpenFiles["f1"];
    } finally {
      warn.mockRestore();
    }
  });

  it("carries a stroke's phase turns into the tier, both ways", async () => {
    installManagerEnv();
    const { canvas } = installPatchRenderer(w, h);
    clearAllHistoryManagers();
    const root = lossyFill(w, h, 0);
    for (let p = 8; p < w * h; p++) {
      root[p * 4 + 1] = Math.fround(1e5 + p);
      root[p * 4 + 3] = Math.fround(-1e5 - p);
    }
    const mgr = getHistoryManager("f1", { packedCacheBytes: 0 });
    await mgr.addRootSnapshot({ data: root, kind: "root", label: "root", spectrogram: makeSpectrogram(root, w, h) });
    const current = mgr.currentPackedState()!;
    const rootBytes = new Float32Array(root);
    canvas.set(current);

    const ranges = new Uint32Array([4, 4]);
    const baseFootprint = current.slice(4 * 4, 8 * 4);
    for (let p = 4; p < 8; p++) for (let c = 0; c < 4; c++) current[p * 4 + c] = ((p * 3 + c) % 31) / 31;
    const c0 = Math.fround(2 * Math.PI);
    const turns: PhaseTurns = {
      pixelStarts: Uint32Array.from([8]),
      pixelCounts: Uint32Array.from([w * h - 8]),
      offsets: Float32Array.from([c0, 0]),
      residuals: new Uint32Array(0),
    };
    applyPhaseTurns(current, turns, false);
    canvas.set(current);
    await mgr.addStroke({ data: current, label: "A", dimensions, dirtyRanges: ranges, baseFootprint, turns });

    const open = getBlockStore("f1");
    expect(open).not.toBeNull();
    const store = await open!;
    // The stroke's tier patch covers the window and the turned tail.
    expect(Array.from(await store.readAll())).toEqual(Array.from(current));

    await mgr.navigateToParent();
    expect(Array.from(await store.readAll())).toEqual(Array.from(rootBytes));

    mgr.dispose();
    delete fakeOpenFiles["f1"];
  });

  beforeEach(() => {
    synthesizeFile.mockClear();
    spliceFileAudio.mockClear();
    loadCachedAudio.mockClear();
  });

  it("walks the kept stroke deltas both ways instead of rebuilding from disk", async () => {
    const { files } = installManagerEnv();
    const { patches } = installPatchRenderer(w, h);
    clearAllHistoryManagers();
    const root = lossyFill(w, h, 0);
    const a = paint(root, 2, 3, 1);
    const b = paint(a, 4, 3, 2);
    const ra = new Uint32Array([2, 3]);
    const rb = new Uint32Array([4, 3]);

    // A cache that only ever holds the newest state, so every hop has to be
    // derived rather than looked up.
    const mgr = getHistoryManager("f1", { packedCacheBytes: 0 });
    await mgr.addRootSnapshot({ data: root, kind: "root", label: "root", spectrogram: makeSpectrogram(root, w, h) });
    await mgr.addStroke({ data: a, label: "A", dimensions, dirtyRanges: ra });
    await mgr.addStroke({ data: b, label: "B", dimensions, dirtyRanges: rb });

    // Counts only history reads: hops may read tier blocks to keep them
    // current, but must never rebuild state from the deltas on disk.
    const reads = (): number =>
      (
        window as unknown as { nodeFs: { readFile: { mock: { calls: [string][] } } } }
      ).nodeFs.readFile.mock.calls.filter(([path]) => path.startsWith("/userdata/history/")).length;
    const readsBefore = reads();
    await mgr.navigateToParent(); // B → A
    expect(Array.from(patches.at(-1)!.data)).toEqual(Array.from(a));
    await mgr.navigateToParent(); // A → root
    expect(Array.from(patches.at(-1)!.data)).toEqual(Array.from(root));
    await mgr.navigateToLastChild(); // root → A
    expect(Array.from(patches.at(-1)!.data)).toEqual(Array.from(a));
    await mgr.navigateToLastChild(); // A → B
    expect(Array.from(patches.at(-1)!.data)).toEqual(Array.from(b));
    expect(reads()).toBe(readsBefore);
    expect(files.size).toBeGreaterThan(0);

    mgr.dispose();
    delete fakeOpenFiles["f1"];
  });

  it("reads a stroke's delta back from disk for a hop it no longer holds", async () => {
    installManagerEnv();
    const { patches, full } = installPatchRenderer(w, h);
    clearAllHistoryManagers();
    const root = lossyFill(w, h, 0);
    const a = paint(root, 1, 4, 3);
    const b = paint(a, 3, 2, 4);

    const mgr = getHistoryManager("f1", { packedCacheBytes: 0 });
    await mgr.addRootSnapshot({ data: root, kind: "root", label: "root", spectrogram: makeSpectrogram(root, w, h) });
    await mgr.addStroke({ data: a, label: "A", dimensions, dirtyRanges: new Uint32Array([1, 4]) });
    const { id: bId } = await mgr.addStroke({ data: b, label: "B", dimensions, dirtyRanges: new Uint32Array([3, 2]) });

    // A fresh manager knows the tree but holds no deltas or ranges; the
    // first hop rebuilds in full, after which the state on screen is known.
    clearAllHistoryManagers();
    const fresh = getHistoryManager("f1", { packedCacheBytes: 0 });
    await fresh.initialize();
    expect(await fresh.currentNodeId()).toBe(bId);
    await fresh.navigateToParent(); // B → A
    expect(Array.from((patches.at(-1)?.data ?? full.at(-1))!)).toEqual(Array.from(a));
    await fresh.navigateToParent(); // A → root
    expect(Array.from((patches.at(-1)?.data ?? full.at(-1))!)).toEqual(Array.from(root));
    await fresh.navigateToLastChild(); // root → A
    expect(Array.from((patches.at(-1)?.data ?? full.at(-1))!)).toEqual(Array.from(a));

    fresh.dispose();
    delete fakeOpenFiles["f1"];
  });

  it("puts a stroke's kept audio back on undo and redo without synthesising", async () => {
    installManagerEnv();
    installPatchRenderer(w, h);
    clearAllHistoryManagers();
    const root = lossyFill(w, h, 0);
    const a = paint(root, 2, 3, 1);
    const mgr = getHistoryManager("f1");
    await mgr.addRootSnapshot({ data: root, kind: "root", label: "root", spectrogram: makeSpectrogram(root, w, h) });
    const { id: aId } = await mgr.addStroke({ data: a, label: "A", dimensions, dirtyRanges: new Uint32Array([2, 3]) });
    const hop: AudioHop = {
      start: 100,
      end: 104,
      before: [new Float32Array([1, 2, 3, 4])],
      after: [new Float32Array([5, 6, 7, 8])],
      beforeMeta: { peak: 0.5 },
      afterMeta: { peak: 0.9, maxGainReductionDb: 3 },
    };
    mgr.setNodeAudioHop(aId, hop);

    await mgr.navigateToParent();
    expect(synthesizeFile).not.toHaveBeenCalled();
    expect(spliceFileAudio).toHaveBeenLastCalledWith("f1", [{ start: 100, channels: hop.before }], hop.beforeMeta);

    await mgr.navigateToLastChild();
    expect(synthesizeFile).not.toHaveBeenCalled();
    expect(spliceFileAudio).toHaveBeenLastCalledWith("f1", [{ start: 100, channels: hop.after }], hop.afterMeta);

    mgr.dispose();
    delete fakeOpenFiles["f1"];
  });

  it("synthesises the hop's window when a stroke kept no audio", async () => {
    installManagerEnv();
    installPatchRenderer(w, h);
    clearAllHistoryManagers();
    const root = lossyFill(w, h, 0);
    const a = paint(root, 2, 3, 1);
    const mgr = getHistoryManager("f1");
    await mgr.addRootSnapshot({ data: root, kind: "root", label: "root", spectrogram: makeSpectrogram(root, w, h) });
    await mgr.addStroke({ data: a, label: "A", dimensions, dirtyRanges: new Uint32Array([2, 3]) });

    await mgr.navigateToParent();
    expect(spliceFileAudio).not.toHaveBeenCalled();
    expect(synthesizeFile).toHaveBeenCalledTimes(1);

    mgr.dispose();
    delete fakeOpenFiles["f1"];
  });

  it("takes a stroke written into the current state in place, and hops it in place", async () => {
    installManagerEnv();
    const { patches } = installPatchRenderer(w, h);
    clearAllHistoryManagers();
    const root = lossyFill(w, h, 0);
    const mgr = getHistoryManager("f1", { packedCacheBytes: 0 });
    await mgr.addRootSnapshot({ data: root, kind: "root", label: "root", spectrogram: makeSpectrogram(root, w, h) });
    const current = mgr.currentPackedState()!;
    expect(current).toBe(root);
    const rootBytes = new Float32Array(root);

    // A commit with projection off: save the footprint's values, then write
    // the stroke over them in the very same array.
    const ranges = new Uint32Array([2, 3]);
    const a = paint(root, 2, 3, 1);
    const baseFootprint = new Float32Array(3 * 4);
    baseFootprint.set(current.subarray(2 * 4, 5 * 4));
    current.set(a.subarray(2 * 4, 5 * 4), 2 * 4);
    const { id: aId, isNew } = await mgr.addStroke({
      data: current,
      label: "A",
      dimensions,
      dirtyRanges: ranges,
      baseFootprint,
    });
    expect(isNew).toBe(true);
    expect(mgr.getNode(aId)?.storage).toBe("delta");
    expect(mgr.currentPackedState()).toBe(current);

    await mgr.navigateToParent();
    expect(mgr.currentPackedState()).toBe(current);
    expect(Array.from(current)).toEqual(Array.from(rootBytes));
    expect(patches.at(-1)!.data).toBe(current);

    await mgr.navigateToLastChild();
    expect(mgr.currentPackedState()).toBe(current);
    expect(Array.from(current)).toEqual(Array.from(a));

    // A stroke that wrote the same values back makes no node.
    const same = await mgr.addStroke({
      data: current,
      label: "same",
      dimensions,
      dirtyRanges: ranges,
      baseFootprint: current.slice(2 * 4, 5 * 4),
    });
    expect(same.isNew).toBe(false);
    expect(same.id).toBe(aId);

    mgr.dispose();
    delete fakeOpenFiles["f1"];
  });

  it("lets a synthesis and an onset pass finish reading the state before a hop writes it", async () => {
    installManagerEnv();
    installPatchRenderer(w, h);
    clearAllHistoryManagers();
    const root = lossyFill(w, h, 0);
    const a = paint(root, 2, 3, 1);
    const mgr = getHistoryManager("f1", { packedCacheBytes: 0 });
    await mgr.addRootSnapshot({ data: root, kind: "root", label: "root", spectrogram: makeSpectrogram(root, w, h) });
    await mgr.addStroke({ data: a, label: "A", dimensions, dirtyRanges: new Uint32Array([2, 3]) });

    let releaseOnsets: (() => void) | null = null;
    restoreOnsetsForNode.mockImplementationOnce(() => new Promise<void>((resolve) => (releaseOnsets = resolve)));
    let releaseSynth: (() => void) | null = null;
    const codec = (window as unknown as { audioAnalysis: { applyHistoryDeltas: ReturnType<typeof vi.fn> } })
      .audioAnalysis;
    const walks = vi.spyOn(codec, "applyHistoryDeltas");

    await mgr.navigateToParent(); // starts the (held) onset restore
    awaitFileSynthesis.mockImplementationOnce(() => new Promise<void>((resolve) => (releaseSynth = resolve)));
    const redo = mgr.navigateToLastChild();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(walks).toHaveBeenCalledTimes(1);

    releaseSynth!();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(walks).toHaveBeenCalledTimes(1);

    releaseOnsets!();
    await redo;
    expect(walks).toHaveBeenCalledTimes(2);
    expect(Array.from(mgr.currentPackedState()!)).toEqual(Array.from(a));

    walks.mockRestore();
    mgr.dispose();
    delete fakeOpenFiles["f1"];
  });

  it("undoes and redoes a stroke's phase turns on the canvas as operations, exactly", async () => {
    installManagerEnv();
    const { patches, full, turns: canvasTurns, canvas } = installPatchRenderer(w, h);
    clearAllHistoryManagers();
    const root = lossyFill(w, h, 0);
    // Phases past pixel 8 run large, as late in a file.
    for (let p = 8; p < w * h; p++) {
      root[p * 4 + 1] = Math.fround(1e5 + p);
      root[p * 4 + 3] = Math.fround(-1e5 - p);
    }
    const mgr = getHistoryManager("f1", { packedCacheBytes: 0 });
    await mgr.addRootSnapshot({ data: root, kind: "root", label: "root", spectrogram: makeSpectrogram(root, w, h) });
    const current = mgr.currentPackedState()!;
    const rootBytes = new Float32Array(root);
    canvas.set(current);

    // A projecting stroke: the window is pixels 4..7, the tail from 8 turns
    // the left channel by one turn and leaves the right alone.
    const ranges = new Uint32Array([4, 4]);
    const baseFootprint = current.slice(4 * 4, 8 * 4);
    for (let p = 4; p < 8; p++) for (let c = 0; c < 4; c++) current[p * 4 + c] = ((p * 3 + c) % 31) / 31;
    const c0 = Math.fround(2 * Math.PI);
    const turns: PhaseTurns = {
      pixelStarts: Uint32Array.from([8]),
      pixelCounts: Uint32Array.from([w * h - 8]),
      offsets: Float32Array.from([c0, 0]),
      residuals: new Uint32Array(0),
    };
    applyPhaseTurns(current, turns, false);
    const a = new Float32Array(current);
    canvas.set(current);
    const { id: aId } = await mgr.addStroke({
      data: current,
      label: "A",
      dimensions,
      dirtyRanges: ranges,
      baseFootprint,
      turns,
    });
    expect(mgr.getNode(aId)?.storage).toBe("delta");

    await mgr.navigateToParent();
    expect(full).toHaveLength(0);
    expect(canvasTurns).toHaveLength(1);
    expect(canvasTurns[0]).toEqual([8, w * h - 8, -c0, -0]);
    expect(Array.from(current)).toEqual(Array.from(rootBytes));
    expect(Array.from(canvas)).toEqual(Array.from(rootBytes));
    // Only the window was uploaded; the tail travelled as an operation.
    expect(Array.from(patches.at(-1)!.ranges)).toEqual([4, 4]);

    await mgr.navigateToLastChild();
    expect(canvasTurns).toHaveLength(2);
    expect(canvasTurns[1]).toEqual([8, w * h - 8, c0, 0]);
    expect(Array.from(current)).toEqual(Array.from(a));
    expect(Array.from(canvas)).toEqual(Array.from(a));
    expect(full).toHaveLength(0);

    mgr.dispose();
    delete fakeOpenFiles["f1"];
  });

  it("uploads a stashed commit patch with the navigation's own ranges", async () => {
    installManagerEnv();
    const { patches, full } = installPatchRenderer(w, h);
    clearAllHistoryManagers();
    const root = lossyFill(w, h, 0);
    const a = paint(root, 2, 3, 1);
    const mgr = getHistoryManager("f1");
    await mgr.addRootSnapshot({ data: root, kind: "root", label: "root", spectrogram: makeSpectrogram(root, w, h) });
    await mgr.addStroke({ data: a, label: "A", dimensions, dirtyRanges: new Uint32Array([2, 3]) });

    setCanvasPatchStash("f1", { data: a, ranges: new Uint32Array([6, 1]), turns: [] });
    await mgr.navigateToParent();
    expect(canvasPatchStashCount()).toBe(0);
    expect(full).toHaveLength(0);
    expect(Array.from(patches.at(-1)!.ranges)).toEqual([2, 3, 6, 1]);
    expect(Array.from(patches.at(-1)!.data)).toEqual(Array.from(root));

    mgr.dispose();
    delete fakeOpenFiles["f1"];
  });
});

describe("HistoryManager side data", () => {
  it("rebuilds the spectrogram on reopen without storing inverseMap or metadata", async () => {
    const { files } = installManagerEnv();
    const w = 6,
      h = 4;
    const root = lossyFill(w, h, 0);
    const spectrogram = makeSpectrogram(root, w, h);

    clearAllHistoryManagers();
    const mgr = getHistoryManager("f1");
    await mgr.addRootSnapshot({ data: root, kind: "root", label: "root", spectrogram });

    // Nothing on disk holds the side data; only the packed state and the tree.
    const written = [...files.keys()];
    expect(written.some((p) => p.endsWith(".inverse.zst"))).toBe(false);
    expect(written.some((p) => p.endsWith(".meta.zst"))).toBe(false);

    // Reopening rebuilds the side data from the band layout in the manifest. The
    // metadata texture is built here, so it must match what the analysis
    // produced; the inverse map comes from the addon (covered in the codec
    // tests), so only its shape is checked against this fake.
    clearAllHistoryManagers();
    const fresh = getHistoryManager("f1");
    const restored = await fresh.loadSpectrogramAtCurrent();
    expect(restored).not.toBeNull();
    expect(Array.from(restored!.metadata)).toEqual(Array.from(spectrogram.metadata));
    expect(restored!.inverseMap.length).toBe(spectrogram.inverseMap.length);
    expect(Array.from(restored!.packedData)).toEqual(Array.from(root));

    clearAllHistoryManagers();
    delete fakeOpenFiles["f1"];
  });
});

describe("HistoryManager pruneAudioCache", () => {
  it("keeps the current, saved and favorited renders and drops the rest", async () => {
    installManagerEnv();
    const w = 6,
      h = 4;
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
    const rootId = await mgr.addRootSnapshot({
      data: lossyFill(w, h, 0),
      kind: "root",
      label: "root",
      spectrogram: makeSpectrogram(lossyFill(w, h, 0), w, h),
    });
    const { id: aId } = await mgr.addStroke({ data: lossyFill(w, h, 1), label: "A", dimensions });
    await mgr.markSaved(); // A is the saved state
    const { id: bId } = await mgr.addStroke({ data: lossyFill(w, h, 2), label: "B", dimensions });
    await mgr.toggleFavorite(bId);
    const { id: cId } = await mgr.addStroke({ data: lossyFill(w, h, 3), label: "C", dimensions });
    const { id: dId } = await mgr.addStroke({ data: lossyFill(w, h, 4), label: "D", dimensions });

    // Every state has a cached render; D is current.
    const manifest = mgr.getManifest()!;
    for (const id of [rootId, aId, bId, cId, dId]) {
      manifest.nodes[id].audioCached = true;
      manifest.nodes[id].audioPeak = 1;
    }

    await mgr.pruneAudioCache();

    expect(manifest.nodes[dId].audioCached).toBe(true); // current
    expect(manifest.nodes[aId].audioCached).toBe(true); // saved
    expect(manifest.nodes[bId].audioCached).toBe(true); // favorited
    expect(manifest.nodes[rootId].audioCached).toBe(false);
    expect(manifest.nodes[cId].audioCached).toBe(false);

    clearAllHistoryManagers();
    delete fakeOpenFiles["f1"];
  });
});

describe("HistoryManager resetToCurrent (purge history)", () => {
  it("collapses to a single root at the current state and keeps undo working", async () => {
    const { fbo, files } = installManagerEnv();
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
    const { id: bId } = await mgr.addStroke({ data: b, label: "B", dimensions });
    expect(mgr.canUndo()).toBe(true);

    await mgr.resetToCurrent();

    // The new root keeps the array the state was already in, not a copy of it.
    expect(mgr.currentPackedState()).toBe(b);
    // Only the current state survives, as the new root — nothing left to undo to.
    expect(mgr.listNodes().length).toBe(1);
    expect(mgr.getCurrentId()).toBe(bId);
    expect(mgr.canUndo()).toBe(false);
    expect(mgr.canRedo()).toBe(false);
    // The fresh seed holds the collapsed state, and the manifest says so.
    const manifest = JSON.parse(files.get("/userdata/history/f1/tree.json") as string) as { overlayNodeId?: string };
    expect(manifest.overlayNodeId).toBe(bId);
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

  it("marks the fresh seed current after a reset from an undone state", async () => {
    const { files } = installManagerEnv();
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
    const { id: aId } = await mgr.addStroke({ data: a, label: "A", dimensions });
    await mgr.addStroke({ data: b, label: "B", dimensions });
    await mgr.navigateToParent();

    await mgr.resetToCurrent();
    const manifest = JSON.parse(files.get("/userdata/history/f1/tree.json") as string) as {
      currentId: string;
      overlayNodeId?: string;
    };
    expect(manifest.currentId).toBe(aId);
    expect(manifest.overlayNodeId).toBe(aId);

    const open = getBlockStore("f1");
    expect(open).not.toBeNull();
    expect(Array.from(await (await open!).readAll())).toEqual(Array.from(a));

    clearAllHistoryManagers();
    delete fakeOpenFiles["f1"];
  });
});

describe("HistoryManager root state alias", () => {
  const w = 8;
  const h = 4;
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
  const ranges = new Uint32Array([2, 3]);

  /**
   * A footprint commit as brush.ts issues one: the old values are gathered, the
   * new ones are scattered into the very same array, and that array is stored.
   */
  async function commitInPlace(mgr: ReturnType<typeof getHistoryManager>, salt: number): Promise<Float32Array> {
    const current = mgr.currentPackedState()!;
    const read = gatherPixelRanges(lossyFill(w, h, salt), ranges);
    const baseFootprint = gatherPixelRanges(current, ranges);
    scatterCompactPixelRanges(current, read, ranges);
    await mgr.addStroke({ data: current, label: "A", dimensions, dirtyRanges: ranges, baseFootprint });
    return current;
  }

  it("takes the analysed packed array as the current state rather than copying it", async () => {
    installManagerEnv();
    const spectrogram = makeSpectrogram(lossyFill(w, h, 0), w, h);
    installPatchRenderer(w, h, spectrogram);
    clearAllHistoryManagers();

    const mgr = getHistoryManager("f1");
    await mgr.addRootSnapshot({ data: spectrogram.packedData, kind: "root", label: "root", spectrogram });
    expect(mgr.currentPackedState()).toBe(spectrogram.packedData);

    mgr.dispose();
    delete fakeOpenFiles["f1"];
  });

  it("undoes to the analysed bytes and redoes to the painted ones", async () => {
    installManagerEnv();
    const spectrogram = makeSpectrogram(lossyFill(w, h, 0), w, h);
    const { canvas } = installPatchRenderer(w, h, spectrogram);
    clearAllHistoryManagers();

    const mgr = getHistoryManager("f1");
    await mgr.addRootSnapshot({ data: spectrogram.packedData, kind: "root", label: "root", spectrogram });
    const analysed = new Float32Array(spectrogram.packedData);
    canvas.set(spectrogram.packedData);

    const current = await commitInPlace(mgr, 1);
    expect(current).toBe(spectrogram.packedData);
    const painted = new Float32Array(current);
    expect(Array.from(painted)).not.toEqual(Array.from(analysed));
    canvas.set(current);

    await mgr.navigateToParent();
    expect(Array.from(mgr.currentPackedState()!)).toEqual(Array.from(analysed));
    expect(Array.from(canvas)).toEqual(Array.from(analysed));

    await mgr.navigateToLastChild();
    expect(Array.from(mgr.currentPackedState()!)).toEqual(Array.from(painted));
    expect(Array.from(canvas)).toEqual(Array.from(painted));

    mgr.dispose();
    delete fakeOpenFiles["f1"];
  });

  it("takes the re-analysed array too, and rounds a stroke on it trip for trip", async () => {
    installManagerEnv();
    const spectrogram = makeSpectrogram(lossyFill(w, h, 0), w, h);
    const { canvas, file } = installPatchRenderer(w, h, spectrogram);
    clearAllHistoryManagers();

    const mgr = getHistoryManager("f1");
    await mgr.addRootSnapshot({ data: spectrogram.packedData, kind: "root", label: "root", spectrogram });

    const reanalysed = makeSpectrogram(lossyFill(w, h, 5), w, h);
    file.spectrogramData = reanalysed;
    await mgr.addSnapshot({
      data: reanalysed.packedData,
      kind: "reanalyze",
      label: "Re-analyse",
      spectrogram: reanalysed,
    });
    expect(mgr.currentPackedState()).toBe(reanalysed.packedData);
    const settled = new Float32Array(reanalysed.packedData);
    canvas.set(reanalysed.packedData);

    const current = await commitInPlace(mgr, 6);
    expect(current).toBe(reanalysed.packedData);
    const painted = new Float32Array(current);
    canvas.set(current);

    await mgr.navigateToParent();
    expect(Array.from(mgr.currentPackedState()!)).toEqual(Array.from(settled));
    expect(Array.from(canvas)).toEqual(Array.from(settled));

    await mgr.navigateToLastChild();
    expect(Array.from(mgr.currentPackedState()!)).toEqual(Array.from(painted));
    expect(Array.from(canvas)).toEqual(Array.from(painted));

    mgr.dispose();
    delete fakeOpenFiles["f1"];
  });
});

describe("HistoryManager under concurrent work", () => {
  const w = 6;
  const h = 4;
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

  /** A root plus two strokes, with the manager sitting on the second. */
  async function seedChain(fileId: string) {
    const root = lossyFill(w, h, 0);
    const a = lossyFill(w, h, 1);
    const b = lossyFill(w, h, 2);
    const mgr = getHistoryManager(fileId);
    await mgr.addRootSnapshot({ data: root, kind: "root", label: "root", spectrogram: makeSpectrogram(root, w, h) });
    const { id: aId } = await mgr.addStroke({ data: a, label: "A", dimensions });
    const { id: bId } = await mgr.addStroke({ data: b, label: "B", dimensions });
    return { mgr, root, a, b, aId, bId };
  }

  it("holds a navigation until the stroke commit ahead of it has finished", async () => {
    const { fbo } = installManagerEnv();
    clearAllHistoryManagers();
    const { mgr, a } = await seedChain("f1");

    // Stands in for a commit: it owns the canvas and the history until it is
    // done, and derives its own delta from the state it started on.
    let releaseCommit: (() => void) | null = null;
    const commitRan: string[] = [];
    const commit = serializeFileTask("f1", async () => {
      commitRan.push("start");
      await new Promise<void>((resolve) => (releaseCommit = resolve));
      commitRan.push("end");
    });

    const navigating = mgr.navigateToParent();
    await Promise.resolve();
    await Promise.resolve();

    // Undo pressed mid-commit must not have touched the canvas yet, or the
    // commit would derive its delta from a base the undo replaced.
    expect(commitRan).toEqual(["start"]);
    expect(fbo.last).toBeNull();

    releaseCommit!();
    await commit;
    await navigating;

    expect(commitRan).toEqual(["start", "end"]);
    expect(Array.from(fbo.last!)).toEqual(Array.from(a));

    clearAllHistoryManagers();
    delete fakeOpenFiles["f1"];
  });

  it("applies overlapping navigations in the order they were asked for", async () => {
    const { fbo } = installManagerEnv();
    clearAllHistoryManagers();
    const { mgr, root, a } = await seedChain("f1");

    const uploads: Float32Array[] = [];
    const rendererRef = (fakeOpenFiles["f1"] as { rendererRef: { current: { setFBOData: unknown } } }).rendererRef;
    rendererRef.current.setFBOData = (d: Float32Array) => {
      uploads.push(Float32Array.from(d));
      fbo.last = d;
    };

    // Both issued before either resolves, as holding Cmd+Z does.
    const first = mgr.navigateToParent();
    const second = mgr.navigateToParent();
    await Promise.all([first, second]);

    expect(uploads.map((u) => Array.from(u))).toEqual([Array.from(a), Array.from(root)]);
    expect(Array.from(fbo.last!)).toEqual(Array.from(root));

    clearAllHistoryManagers();
    delete fakeOpenFiles["f1"];
  });

  it("drops a navigation whose file closed while it was rebuilding state", async () => {
    const { fbo } = installManagerEnv();
    await clearAllHistoryManagers();
    const { aId } = await seedChain("f1");

    // A manager with no in-memory packed state rebuilds the target from disk,
    // which is the only path that awaits long enough for a close to land in it.
    await clearAllHistoryManagers();
    const mgr = getHistoryManager("f1");
    await mgr.initialize();

    const nodeFs = (window as unknown as { nodeFs: { readFile: (p: string, e?: string) => Promise<unknown> } }).nodeFs;
    const realReadFile = nodeFs.readFile;
    let releaseRead: (() => void) | null = null;
    nodeFs.readFile = async (path: string, encoding?: string) => {
      if (path.endsWith(".json")) return realReadFile(path, encoding);
      await new Promise<void>((resolve) => (releaseRead = resolve));
      return realReadFile(path, encoding);
    };

    const navigating = mgr.navigateTo(aId);
    while (releaseRead === null) await new Promise((resolve) => setTimeout(resolve, 0));
    const release = releaseRead as () => void;

    // The tab is closed mid-rebuild: the manifest is wiped and the renderer
    // the restore would have written to is gone.
    await mgr.purge();
    delete fakeOpenFiles["f1"];

    release();
    await expect(navigating).resolves.toBeUndefined();
    expect(fbo.last).toBeNull();

    nodeFs.readFile = realReadFile;
    clearAllHistoryManagers();
  });

  it("holds the quit cleanup until an in-flight commit has finished", async () => {
    installManagerEnv();
    clearAllHistoryManagers();
    await seedChain("f1");

    let releaseCommit: (() => void) | null = null;
    let committed = false;
    const commit = serializeFileTask("f1", async () => {
      await new Promise<void>((resolve) => (releaseCommit = resolve));
      committed = true;
    });

    let quitDone = false;
    const quitting = clearAllHistoryManagers().then(() => {
      quitDone = true;
    });
    await vi.waitFor(() => expect(releaseCommit).not.toBeNull());
    await new Promise((resolve) => setTimeout(resolve, 0));

    // Reporting the cleanup done here would let main destroy the window with
    // the commit's history write still to come.
    expect(quitDone).toBe(false);

    releaseCommit!();
    await commit;
    await quitting;
    expect(committed).toBe(true);

    delete fakeOpenFiles["f1"];
  });

  it("has the navigated-to node on disk once dispose resolves", async () => {
    const { files } = installManagerEnv();
    clearAllHistoryManagers();
    const { mgr, aId } = await seedChain("f1");

    // Navigation only schedules a debounced manifest write, so quitting now is
    // the case where the position is still in memory alone.
    await mgr.navigateToParent();
    expect(mgr.getCurrentId()).toBe(aId);

    // A real filesystem write does not land within a microtask, and the main
    // process closes the window as soon as the quit cleanup resolves.
    const nodeFs = (window as unknown as { nodeFs: { writeFile: (p: string, d: unknown) => Promise<void> } }).nodeFs;
    const realWriteFile = nodeFs.writeFile;
    let manifestWritten = false;
    nodeFs.writeFile = async (path: string, data: unknown) => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      await realWriteFile(path, data);
      if (path.endsWith("tree.json")) manifestWritten = true;
    };

    await clearAllHistoryManagers();
    expect(manifestWritten).toBe(true);
    nodeFs.writeFile = realWriteFile;

    const manifestPath = [...files.keys()].find((k) => k.endsWith("tree.json"));
    expect(manifestPath).toBeDefined();
    expect(JSON.parse(files.get(manifestPath!) as string).currentId).toBe(aId);

    delete fakeOpenFiles["f1"];
  });
});

describe("HistoryManager reshaped store", () => {
  const w = 8;
  const h = 4;
  const w2 = 10;
  const dims1 = {
    textureWidth: w,
    textureHeight: h,
    numFrames: w,
    numBands: h,
    numChannels: 1,
    sampleRate: 44100,
    minFreq: 20,
    bandsPerOctave: 12,
  };
  const dims2 = { ...dims1, textureWidth: w2, numFrames: w2 };

  /** Paints pixels `start..start+count` of `base` with a lossy fill keyed by `salt`. */
  function paintAt(base: Float32Array, start: number, count: number, salt: number): Float32Array {
    const out = new Float32Array(base);
    for (let p = start; p < start + count; p++) {
      for (let c = 0; c < 4; c++) out[p * 4 + c] = ((p * 7 + c + salt) % 89) / 89 + salt * 0.011;
    }
    return out;
  }

  /** Root, a stroke, then a re-analysis on a wider grid, then a stroke on it. */
  async function reshapedChain(files: Map<string, string | Uint8Array>) {
    const spectrogram = makeSpectrogram(lossyFill(w, h, 0), w, h);
    const { file } = installPatchRenderer(w, h, spectrogram);
    clearAllHistoryManagers();

    const mgr = getHistoryManager("f1");
    const rootId = await mgr.addRootSnapshot({
      data: spectrogram.packedData,
      kind: "root",
      label: "root",
      spectrogram,
    });
    const rootBytes = new Float32Array(spectrogram.packedData);
    const a = paintAt(spectrogram.packedData, 2, 3, 1);
    const { id: aId } = await mgr.addStroke({
      data: a,
      label: "A",
      dimensions: dims1,
      dirtyRanges: new Uint32Array([2, 3]),
    });
    expect(files.has(`/userdata/history/f1/${rootId}.packed.zst`)).toBe(false);

    const reanalysed = makeSpectrogram(lossyFill(w2, h, 5), w2, h);
    file.spectrogramData = reanalysed;
    const snapId = await mgr.addSnapshot({
      data: reanalysed.packedData,
      kind: "reanalyze",
      label: "Re-analyse",
      spectrogram: reanalysed,
    });
    const snapBytes = new Float32Array(reanalysed.packedData);

    const b = paintAt(snapBytes, 2, 3, 6);
    const { id: bId } = await mgr.addStroke({
      data: b,
      label: "B",
      dimensions: dims2,
      dirtyRanges: new Uint32Array([2, 3]),
    });
    return { mgr, rootId, aId, snapId, bId, rootBytes, a, snapBytes, b };
  }

  it("moves the seed to a re-analysis and demotes the old root to a file", async () => {
    const { files } = installManagerEnv();
    const { mgr, rootId, aId, snapId, rootBytes, a, snapBytes, b } = await reshapedChain(files);

    // The old root now has its own file; the re-analysis has none — it is the seed.
    expect(files.has(`/userdata/history/f1/${rootId}.packed.zst`)).toBe(true);
    expect(files.has(`/userdata/history/f1/${snapId}.packed.zst`)).toBe(false);
    const manifest = JSON.parse(files.get("/userdata/history/f1/tree.json") as string) as {
      seedNodeId?: string;
      overlayNodeId?: string;
    };
    expect(manifest.seedNodeId).toBe(snapId);

    expect(Array.from((await mgr.reconstruct(rootId)).packedData)).toEqual(Array.from(rootBytes));
    expect(Array.from((await mgr.reconstruct(aId)).packedData)).toEqual(Array.from(a));
    expect(Array.from((await mgr.reconstruct(snapId)).packedData)).toEqual(Array.from(snapBytes));

    // Strokes on the new grid keep the tier current over the new seed.
    const open = getBlockStore("f1");
    expect(open).not.toBeNull();
    const store = await open!;
    expect(Array.from(await store.readAll())).toEqual(Array.from(b));
    expect(Array.from(await store.readAllRoot())).toEqual(Array.from(snapBytes));

    mgr.dispose();
    delete fakeOpenFiles["f1"];
  });

  it("leaves the tier alone for a stroke on the old grid after an undo across the boundary", async () => {
    const { files } = installManagerEnv();
    const { mgr, aId, snapId, bId, a, snapBytes, b } = await reshapedChain(files);

    await mgr.navigateTo(aId);
    const aState = new Float32Array(mgr.currentPackedState()!);
    expect(Array.from(aState)).toEqual(Array.from(a));
    const c = paintAt(aState, 4, 2, 7);
    const { id: cId } = await mgr.addStroke({
      data: c,
      label: "C",
      dimensions: dims1,
      dirtyRanges: new Uint32Array([4, 2]),
    });

    // The tier still holds the re-analysis side, and the marker still says so.
    const open = getBlockStore("f1");
    expect(open).not.toBeNull();
    const store = await open!;
    expect(Array.from(await store.readAll())).toEqual(Array.from(b));
    expect(Array.from(await store.readAllRoot())).toEqual(Array.from(snapBytes));
    const manifest = JSON.parse(files.get("/userdata/history/f1/tree.json") as string) as {
      seedNodeId?: string;
      overlayNodeId?: string;
    };
    expect(manifest.overlayNodeId).toBe(bId);
    expect(manifest.seedNodeId).toBe(snapId);

    expect(Array.from((await mgr.reconstruct(cId)).packedData)).toEqual(Array.from(c));

    mgr.dispose();
    delete fakeOpenFiles["f1"];
  });
});
