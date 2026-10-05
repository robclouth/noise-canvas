import {
  FloatType,
  GLSL3,
  Mesh,
  NearestFilter,
  OrthographicCamera,
  PlaneGeometry,
  RawShaderMaterial,
  RGBAFormat,
  Scene,
  WebGLRenderTarget,
} from "three";
import { describe, expect, it } from "vitest";
import { createDefaultUniforms } from "../../effects/base-effect";
import passThroughVert from "../../glsl/pass-through.vert";
import probeFrag from "../../test/band-start-probe.frag";
import { createGL } from "../../test/render-harness";
import { bandLayoutOf } from "../band-layout";
import { bandMetadataTexture } from "../band-metadata-texture";

describe("bandStartTexel", () => {
  it("finds every band's first texel exactly past 2^24 texels", () => {
    const offsets = [0, 1, 16_777_215, 16_777_217, 33_554_433, 50_331_651, 67_108_863];
    const n = offsets.length;
    const layout = bandLayoutOf(
      n,
      offsets,
      offsets.map(() => 1),
      offsets.map(() => 0),
      offsets.map((_, i) => 1000 * (i + 1)),
    );
    const metaTex = bandMetadataTexture(layout, 48000);
    const gl = createGL();
    const material = new RawShaderMaterial({
      uniforms: { ...createDefaultUniforms(), probeMetaTex: { value: metaTex } },
      vertexShader: passThroughVert,
      fragmentShader: probeFrag,
      glslVersion: GLSL3,
    });
    const target = new WebGLRenderTarget(n, 1, {
      type: FloatType,
      format: RGBAFormat,
      minFilter: NearestFilter,
      magFilter: NearestFilter,
    });
    const scene = new Scene().add(new Mesh(new PlaneGeometry(2, 2), material));
    gl.setRenderTarget(target);
    gl.render(scene, new OrthographicCamera(-1, 1, 1, -1, 0, 1));
    const out = new Float32Array(n * 4);
    gl.readRenderTargetPixels(target, 0, 0, n, 1, out);
    gl.setRenderTarget(null);
    target.dispose();
    material.dispose();
    metaTex.dispose();
    gl.dispose();

    expect(offsets.map((_, i) => out[i * 4] * 4096 + out[i * 4 + 1])).toEqual(offsets);
  });
});
