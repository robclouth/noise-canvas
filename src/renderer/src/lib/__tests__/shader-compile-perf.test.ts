import {
  Camera,
  FloatType,
  GLSL3,
  Mesh,
  NearestFilter,
  PlaneGeometry,
  RawShaderMaterial,
  RGBAFormat,
  Scene,
  WebGLRenderer,
  WebGLRenderTarget,
} from "three";
import { describe, expect, it } from "vitest";
import passThroughVert from "../../glsl/pass-through.vert";
import alignFrag from "../../glsl/align-effect.frag";
import binauralFrag from "../../glsl/binaural-effect.frag";
import blurFrag from "../../glsl/blur-effect.frag";
import cloneFrag from "../../glsl/clone-effect.frag";
import convolveFrag from "../../glsl/convolve-effect.frag";
import dynamicsFrag from "../../glsl/dynamics-effect.frag";
import evolveFrag from "../../glsl/evolve-effect.frag";
import overtonesFrag from "../../glsl/overtones-effect.frag";
import passthroughFrag from "../../glsl/passthrough-effect.frag";
import sortFrag from "../../glsl/sort-effect.frag";
import synthesizeFrag from "../../glsl/synthesize-effect.frag";
import transformFrag from "../../glsl/transform-effect.frag";
import transmuteFrag from "../../glsl/transmute-effect.frag";
import waveshapeFrag from "../../glsl/waveshape-effect.frag";
import modulatorPrecomputeFrag from "../../glsl/modulator-precompute.frag";
import { withPlatformDefines } from "../shader-utils";

// Measures the wall-clock cost of the first draw of each effect shader -- the
// point at which the backend compiles the pipeline state. Each effect's program
// is reproduced exactly as the app builds it: withPlatformDefines(frag) +
// passThroughVert + GLSL3 (effects add no per-pass frag defines). Importing the
// .frag files directly keeps the store -- and its circular init -- out of the
// way. gl.finish() bounds the GPU work so the timing captures the real compile.

const EFFECT_FRAGS: { name: string; frag: string }[] = [
  { name: "dynamics", frag: dynamicsFrag },
  { name: "transform", frag: transformFrag },
  { name: "overtones", frag: overtonesFrag },
  { name: "blur", frag: blurFrag },
  { name: "clone", frag: cloneFrag },
  { name: "synthesize", frag: synthesizeFrag },
  { name: "evolve", frag: evolveFrag },
  { name: "passthrough", frag: passthroughFrag },
  { name: "binaural", frag: binauralFrag },
  { name: "sort", frag: sortFrag },
  { name: "transmute", frag: transmuteFrag },
  { name: "waveshape", frag: waveshapeFrag },
  { name: "convolve", frag: convolveFrag },
  { name: "align", frag: alignFrag },
  // The precompute pass now carries the heavy modulator evaluator (compiled once).
  { name: "mod-precompute", frag: modulatorPrecomputeFrag },
];

const TRIVIAL_FRAG = `precision highp float;
out vec4 o;
void main() { o = vec4(1.0); }`;

// Extra #defines prepended to every effect frag, comma-separated, supplied via
// VITE_SHADER_DEFINES. Used to ablate code paths (e.g. DISABLE_NESTED_MODULATION,
// ABLATE_MODULATION, ABLATE_PATTERN_EVAL) and compare TOTAL across runs to find
// what drives compile cost.
//
// Note: the GPU caches compiled pipelines keyed on the *translated* MSL, which
// persists across processes, so re-running the same source is warm. A real code
// change produces new MSL and compiles cold on its first run; to force a cold
// baseline, clear the platform shader cache first (on macOS: move aside
// "$(getconf DARWIN_USER_CACHE_DIR)com.apple.metal"). An unused #define does NOT
// force a miss -- the translator strips it, yielding identical MSL.
const ablationDefines = (import.meta.env.VITE_SHADER_DEFINES ?? "")
  .split(",")
  .map((d: string) => d.trim())
  .filter((d: string) => d.length > 0);

function withAblationDefines(frag: string): string {
  if (ablationDefines.length === 0) return frag;
  const header = ablationDefines.map((d: string) => `#define ${d}`).join("\n");
  // Raw frags have no #version (Three prepends it for GLSL3 RawShaderMaterials),
  // so a leading #define block is safe.
  return `${header}\n${frag}`;
}

describe("shader compile cost", () => {
  it("times first-draw pipeline compile per effect", () => {
    const canvas = document.createElement("canvas");
    canvas.width = 8;
    canvas.height = 8;
    const renderer = new WebGLRenderer({ canvas });
    const gl = renderer.getContext();
    const target = new WebGLRenderTarget(8, 8, {
      format: RGBAFormat,
      type: FloatType,
      minFilter: NearestFilter,
      magFilter: NearestFilter,
    });
    renderer.setRenderTarget(target);

    const scene = new Scene();
    const camera = new Camera();
    const mesh = new Mesh(new PlaneGeometry(2, 2));
    mesh.frustumCulled = false;
    scene.add(mesh);

    const glRenderer = gl.getParameter(gl.RENDERER);
    const glVendor = gl.getParameter(gl.VENDOR);

    const drawOnce = (frag: string): number => {
      const m = new RawShaderMaterial({ vertexShader: passThroughVert, fragmentShader: frag, glslVersion: GLSL3 });
      mesh.material = m;
      const t0 = performance.now();
      renderer.render(scene, camera);
      gl.finish();
      const dt = performance.now() - t0;
      m.dispose();
      return dt;
    };

    // Warm the context with a trivial program so context-init cost is not
    // attributed to the first effect.
    const trivialMs = drawOnce(TRIVIAL_FRAG);

    const rows: { name: string; ms: number; chars: number }[] = [];
    for (const { name, frag } of EFFECT_FRAGS) {
      const src = withAblationDefines(withPlatformDefines(frag));
      const ms = drawOnce(src);
      rows.push({ name, ms, chars: src.length });
    }

    rows.sort((a, b) => b.ms - a.ms);
    const total = rows.reduce((s, r) => s + r.ms, 0);
    const table = rows
      .map((r) => `  ${r.name.padEnd(14)} ${r.ms.toFixed(1).padStart(9)} ms   ${r.chars} chars`)
      .join("\n");
    console.log(
      `\nGL_RENDERER: ${glRenderer}\nGL_VENDOR: ${glVendor}\n` +
        `\n=== Effect first-draw compile cost [defines: ${ablationDefines.join(",") || "none"}] ===\n` +
        `  ${"(trivial)".padEnd(14)} ${trivialMs.toFixed(1).padStart(9)} ms (context warmup)\n` +
        `${table}\n` +
        `  ${"TOTAL".padEnd(14)} ${total.toFixed(1).padStart(9)} ms  (${rows.length} effects)\n`,
    );

    target.dispose();
    renderer.dispose();
    expect(rows.length).toBe(EFFECT_FRAGS.length);
  }, 600000);
});
