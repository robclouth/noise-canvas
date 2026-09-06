import { describe, expect, it } from "vitest";

import { createConstantQMockSpectrogramData } from "../../test/mock-spectrogram";
import { blockGrid, blockPixelRanges } from "../block-grid";
import { CoarseStripBuilder, coarseStripLevel, levelBins } from "../coarse-strip";
import { displayPyramidLevels } from "../display-pyramid";
import { gatherPixelRanges } from "../pixel-ranges";

const SAMPLE_RATE = 8000;
const data = createConstantQMockSpectrogramData({ durationSeconds: 2, sampleRate: SAMPLE_RATE, bandsPerOctave: 4 });
const layout = { numBands: data.numBands, metadata: data.metadata };

// Every channel varies along the packed layout, so a tap taken from the wrong
// bin or the wrong channel shows.
const packed = Float32Array.from(data.packedData);
for (let i = 0; i < packed.length; i++) packed[i] = Math.sin(i * 0.013) * 0.5 + 0.5;

describe("coarse strip", () => {
  it("picks the finest pyramid level whose bins fit the cap", () => {
    const levels = displayPyramidLevels(layout);
    const cap = levelBins(levels[2]);
    const level = coarseStripLevel(layout, cap);
    expect(level.stepLog2).toBe(levels[2].stepLog2);
    expect(levelBins(levels[1])).toBeGreaterThan(cap);
  });

  it("holds every level bin's tap, gathered from blocks as they land", () => {
    const grid = blockGrid(layout, data.numFrames, SAMPLE_RATE, 0.25);
    const levels = displayPyramidLevels(layout);
    const level = levels[2];
    const builder = new CoarseStripBuilder(layout, level);
    for (let index = 0; index < grid.blockCount; index++) {
      const list = blockPixelRanges(grid, index);
      const ranges = list.ranges.slice(0, list.count * 2);
      builder.add(ranges, gatherPixelRanges(packed, ranges));
    }
    const { values } = builder.strip();
    expect(values.length).toBe(levelBins(level) * 2);
    for (let band = 0; band < layout.numBands; band++) {
      const offset = layout.metadata[band * 4];
      const decimation = 2 ** (level.metadata[band * 4 + 2] - layout.metadata[band * 4 + 2]);
      const levelOffset = level.metadata[band * 4];
      for (let j = 0; j < level.metadata[band * 4 + 1]; j++) {
        const source = (offset + j * decimation) * 4;
        expect(values[(levelOffset + j) * 2]).toBe(packed[source]);
        expect(values[(levelOffset + j) * 2 + 1]).toBe(packed[source + 2]);
      }
    }
  });
});
