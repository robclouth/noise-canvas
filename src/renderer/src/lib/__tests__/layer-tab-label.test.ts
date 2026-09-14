import { describe, expect, it } from "vitest";
import { layerTabLabel } from "../layer-tab-label";

describe("layer tab labels", () => {
  it.each([
    ["Song part 3", "Song", "part 3"],
    ["Song part 3", "Song: 6 parts", "part 3"],
    ["Song harmonic", "Song: harmonic / percussive", "harmonic"],
    ["Song vocals.wav", "Song: drums / bass / other / vocals", "vocals"],
    ["Song harmonic.wav", "Song", "harmonic"],
    ["Song vocals", "Song", "vocals"],
    ["Song layer 2", "Song", "layer 2"],
    ["Song harmonic layer 3", "Song: harmonic / percussive", "layer 3"],
    ["A different recording.wav", "Song", "A different recording"],
    ["Song.v2 part 1", "Song.v2", "part 1"],
    ["Song.wav", "Song", "Song"],
  ])("shortens %s within %s", (name, stack, expected) => {
    expect(layerTabLabel(name, stack)).toBe(expected);
  });
});
