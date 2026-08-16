import { describe, expect, it, vi } from "vitest";

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

import { clearAllHistoryManagers, getHistoryManager, PackedStateCache } from "../history-manager";
import { serializeFileTask } from "../file-task-queue";
import type { SpectrogramData } from "../../store/types";

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
function fakeHistoryCodec(): Record<string, unknown> {
  const bytesOf = (a: Float32Array): Uint8Array => new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
  const footprint = (ranges: Uint32Array): number[] => {
    const indices: number[] = [];
    for (let r = 0; r < ranges.length; r += 2) {
      for (let p = ranges[r]; p < ranges[r] + ranges[r + 1]; p++) {
        for (let c = 0; c < 4; c++) indices.push(p * 4 + c);
      }
    }
    return indices;
  };

  return {
    encodeHistorySnapshot: async (packed: Float32Array) => new Uint8Array(bytesOf(packed)),
    decodeHistorySnapshot: async (bytes: Uint8Array) => new Float32Array(bytes.slice().buffer),
    historyFootprintChanged: async (base: Float32Array, after: Float32Array, ranges: Uint32Array) =>
      footprint(ranges).some((i) => base[i] !== after[i]),
    encodeHistoryDelta: async (_base: Float32Array, after: Float32Array, ranges: Uint32Array) => {
      const indices = footprint(ranges);
      const out = new Float32Array(1 + ranges.length + indices.length);
      out[0] = ranges.length;
      out.set(ranges, 1);
      indices.forEach((src, i) => (out[1 + ranges.length + i] = after[src]));
      return new Uint8Array(bytesOf(out));
    },
    applyHistoryDelta: async (base: Float32Array, bytes: Uint8Array) => {
      const blob = new Float32Array(bytes.slice().buffer);
      const rangeCount = blob[0];
      const ranges = new Uint32Array(Array.from(blob.subarray(1, 1 + rangeCount)));
      const values = blob.subarray(1 + rangeCount);
      const out = new Float32Array(base);
      footprint(ranges).forEach((dst, i) => (out[dst] = values[i]));
      return out;
    },
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
    const { id: bId } = await mgr.addStroke({ data: b, label: "B", dimensions });
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
