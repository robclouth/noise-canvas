import { describe, expect, it, vi } from "vitest";

// parameters.ts sits in a cycle with the store; nothing here needs the store.
vi.mock("@renderer/store", () => ({ useStore: { getState: vi.fn() } }));

import { getNumberParameterDef } from "../../parameters";
import { ENVELOPE_SHAPES, ENVELOPE_SHAPE_PARAMS, drawEnvelope, type EnvelopeShapeValues } from "../envelope-shapes";

const WIDTH = 64;
const HEIGHT = 44;

/** The tile's own pixels: the field a user picks the shape by. */
function renderTile(values: EnvelopeShapeValues): Uint8ClampedArray {
  const canvas = document.createElement("canvas");
  canvas.width = WIDTH;
  canvas.height = HEIGHT;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("no 2d context");
  drawEnvelope(ctx, values, 100);
  return ctx.getImageData(0, 0, WIDTH, HEIGHT).data;
}

describe("envelope shapes", () => {
  it("only sets values the parameters accept", () => {
    const outOfRange: string[] = [];
    for (const shape of ENVELOPE_SHAPES) {
      for (const key of ENVELOPE_SHAPE_PARAMS) {
        const def = getNumberParameterDef(key);
        for (const value of [shape.values[key], shape.preview?.[key]]) {
          if (value === undefined) continue;
          if (value < def.min || value > def.max) outOfRange.push(`${shape.name}.${key} = ${value}`);
        }
      }
    }
    expect(outOfRange).toEqual([]);
  });

  it("names each shape once", () => {
    const names = ENVELOPE_SHAPES.map((shape) => shape.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("draws a different envelope for every tile", () => {
    const tiles = ENVELOPE_SHAPES.map((shape) => ({
      name: shape.name,
      pixels: renderTile(shape.preview ?? shape.values),
    }));
    const alike: string[] = [];

    for (let a = 0; a < tiles.length; a++) {
      for (let b = a + 1; b < tiles.length; b++) {
        let differing = 0;
        for (let i = 0; i < tiles[a].pixels.length; i += 4) {
          if (Math.abs(tiles[a].pixels[i] - tiles[b].pixels[i]) > 8) differing++;
        }
        const fraction = differing / (WIDTH * HEIGHT);
        if (fraction < 0.05) alike.push(`${tiles[a].name} / ${tiles[b].name} (${Math.round(fraction * 100)}%)`);
      }
    }

    expect(alike, "these tiles are too close to tell apart").toEqual([]);
  });
});
