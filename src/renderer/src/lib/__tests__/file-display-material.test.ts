import { Color, DataTexture, Vector2 } from "three";
import { describe, expect, it, vi } from "vitest";
import { createFileDisplayMaterial, disposeFileDisplayMaterial } from "../file-display-material";

describe("file display material ownership", () => {
  it("keeps every uniform wrapper private to its material", () => {
    const range = { displayMinDb: -84, displayMaxDb: -6 };
    const first = createFileDisplayMaterial(range);
    const second = createFileDisplayMaterial(range);
    try {
      for (const name of Object.keys(first.uniforms)) {
        expect(first.uniforms[name], name).not.toBe(second.uniforms[name]);
      }
      expect(first.uniforms.minDb.value).toBe(-84);
      expect(first.uniforms.maxDb.value).toBe(-6);
      const firstTint = first.uniforms.leftTint.value as Color;
      const secondTint = second.uniforms.leftTint.value as Color;
      const savedTint = secondTint.clone();
      firstTint.setRGB(0.1, 0.2, 0.3);
      expect(secondTint).toEqual(savedTint);
      const firstBrush = first.uniforms.sourceBrushSizeUv.value as Vector2;
      const secondBrush = second.uniforms.sourceBrushSizeUv.value as Vector2;
      firstBrush.set(0.7, 0.8);
      expect(secondBrush.toArray()).toEqual([0.1, 0.1]);
      first.uniforms.previewActive.value = true;
      first.uniforms.displayTileCount.value = 4;
      expect(second.uniforms.previewActive.value).toBe(false);
      expect(second.uniforms.displayTileCount.value).toBe(0);
    } finally {
      disposeFileDisplayMaterial(first);
      disposeFileDisplayMaterial(second);
    }
  });

  it("disposes the material without disposing its borrowed texture", () => {
    const material = createFileDisplayMaterial({ displayMinDb: -90, displayMaxDb: 0 });
    const texture = new DataTexture();
    const materialDisposed = vi.fn();
    const textureDisposed = vi.fn();
    material.addEventListener("dispose", materialDisposed);
    texture.addEventListener("dispose", textureDisposed);
    material.uniforms.sourceSpectrogramTex.value = texture;
    try {
      disposeFileDisplayMaterial(material);
      expect(materialDisposed).toHaveBeenCalledTimes(1);
      expect(textureDisposed).not.toHaveBeenCalled();
    } finally {
      texture.dispose();
    }
  });
});
