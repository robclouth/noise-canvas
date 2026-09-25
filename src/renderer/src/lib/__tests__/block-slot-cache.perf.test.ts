import { FloatType, Mesh, NearestFilter, RGBAFormat, WebGLRenderer, WebGLRenderTarget } from "three";
import { expect, it, vi } from "vitest";
import { createConstantQMockSpectrogramData } from "../../test/mock-spectrogram";
import { blockGrid, blockPixelRanges, blockTexels, PACKED_BYTES_PER_TEXEL } from "../block-grid";
import { BlockSlotCache } from "../block-slot-cache";
import { canvasViewOf } from "../canvas-view";
import { gatherPixelRanges } from "../pixel-ranges";

/** Counts identities without keeping disposed objects alive during the profile. */
function countedObjects() {
  const seen = new WeakSet<object>();
  let size = 0;
  return {
    get size() {
      return size;
    },
    add(value: object): boolean {
      if (seen.has(value)) return false;
      seen.add(value);
      size++;
      return true;
    },
  };
}

/** Counts resources submitted by real slot uploads, compositions and patches. */
it("profiles repeated slot copies after warm-up", () => {
  const data = createConstantQMockSpectrogramData({ durationSeconds: 2, sampleRate: 8000, bandsPerOctave: 4 });
  const grid = blockGrid(data, data.numFrames, data.sampleRate, 0.25);
  const blocks = [2, 3, 4];
  const view = canvasViewOf(grid, 2, 4);
  const values = blocks.map((block) => {
    const ranges = blockPixelRanges(grid, block);
    return gatherPixelRanges(data.packedData, ranges.ranges.subarray(0, ranges.count * 2));
  });
  const gl = new WebGLRenderer({ antialias: false });
  try {
    for (let repeat = 1; repeat <= 2; repeat++) {
      const cache = new BlockSlotCache(gl, grid, grid.blockCount * blockTexels(grid, 0) * PACKED_BYTES_PER_TEXEL);
      const target = new WebGLRenderTarget(view.textureWidth, view.textureHeight, {
        format: RGBAFormat,
        type: FloatType,
        minFilter: NearestFilter,
        magFilter: NearestFilter,
        depthBuffer: false,
        stencilBuffer: false,
      });
      const patched = gatherPixelRanges(data.packedData, view.ranges);
      const cycle = () => {
        blocks.forEach((block, i) => cache.upload(block, values[i]));
        cache.compose(view, blocks, target);
        cache.patch(view.ranges, patched);
        cache.compose(view, blocks, target);
      };
      for (let warm = 0; warm < 10; warm++) cycle();
      const scenes = countedObjects();
      const meshes = countedObjects();
      const geometries = countedObjects();
      const attributes = countedObjects();
      const arrays = countedObjects();
      let rangeBytes = 0;
      let draws = 0;
      const render = gl.render.bind(gl);
      const spy = vi.spyOn(gl, "render").mockImplementation((scene, camera) => {
        const mesh = scene.children[0];
        if (!(mesh instanceof Mesh)) throw new Error("slot copy has no mesh");
        draws++;
        scenes.add(scene);
        meshes.add(mesh);
        geometries.add(mesh.geometry);
        attributes.add(mesh.geometry.index!);
        for (const attribute of Object.values(mesh.geometry.attributes)) {
          if (typeof attribute === "object" && attribute !== null) attributes.add(attribute);
        }
        const array = mesh.geometry.getAttribute("aRange").array;
        if (arrays.add(array)) rangeBytes += array.byteLength;
        render(scene, camera);
      });
      try {
        const times: number[] = [];
        for (let cycleIndex = 0; cycleIndex < 200; cycleIndex++) {
          const start = performance.now();
          cycle();
          times.push(performance.now() - start);
        }
        times.sort((a, b) => a - b);
        console.log(
          "SLOT_COPY_PROFILE",
          JSON.stringify({
            repeat,
            cycles: times.length,
            draws,
            scenes: scenes.size,
            meshes: meshes.size,
            geometries: geometries.size,
            attributes: attributes.size,
            rangeArrays: arrays.size,
            rangeBytes,
            p50: times[99],
            p95: times[189],
            p99: times[197],
          }),
        );
        expect(draws).toBe(1200);
      } finally {
        spy.mockRestore();
        cache.dispose();
        target.dispose();
      }
    }
  } finally {
    gl.dispose();
  }
});
