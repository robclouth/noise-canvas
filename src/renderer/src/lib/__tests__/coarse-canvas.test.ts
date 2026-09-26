import { describe, expect, it } from "vitest";
import { createConstantQMockSpectrogramData } from "../../test/mock-spectrogram";
import { coarseLevelIndex, levelCanvasView } from "../coarse-canvas";
import { displayLevelChoice, displayPyramidLevels } from "../display-pyramid";

const data = createConstantQMockSpectrogramData({ durationSeconds: 60, sampleRate: 8000, bandsPerOctave: 12 });
const levels = displayPyramidLevels({ numBands: data.numBands, metadata: data.metadata });

describe("the coarse canvas's level", () => {
  it("lays out a view over the whole file as the level does", () => {
    const level = levels[2];
    const view = levelCanvasView(level, data.numFrames);
    expect(Array.from(view.layout.metadata)).toEqual(Array.from(level.metadata));
    expect(view.startFrame).toBe(0);
    expect(view.endFrame).toBe(data.numFrames);
    expect(view.textureWidth * view.textureHeight).toBeGreaterThanOrEqual(view.texels);
  });

  it("takes the level the screen draws, or the finest coarser one that fits", () => {
    const framesPerPixel = 4;
    const drawn = displayLevelChoice(levels, framesPerPixel).fine;
    expect(coarseLevelIndex(levels, framesPerPixel, 0, Infinity)).toBe(drawn);
    const cap = levelCanvasView(levels[drawn + 1], data.numFrames).texels;
    const index = coarseLevelIndex(levels, framesPerPixel, 0, cap);
    expect(index).toBe(drawn + 1);
    expect(levelCanvasView(levels[index - 1], data.numFrames).texels).toBeGreaterThan(cap);
  });
});
