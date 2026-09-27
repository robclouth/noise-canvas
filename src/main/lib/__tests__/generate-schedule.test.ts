import { describe, expect, it } from "vitest";
import { GENERATE_MAX_SECONDS, generateChunks, generateSchedule } from "../generate";

describe("Generate noise schedule", () => {
  it("is the model's own schedule at strength 1", () => {
    const expected = [1, 0.994, 0.984, 0.958, 0.891, 0.746, 0.512, 0.274, 0];
    const sigmas = generateSchedule(1);
    expected.forEach((value, i) => expect(sigmas[i]).toBeCloseTo(value, 3));
  });

  it("runs the last share of the model's schedule that the strength names", () => {
    const full = generateSchedule(1, 8);
    expect(Array.from(generateSchedule(0.5, 4)).map((v) => v.toFixed(5))).toEqual(
      Array.from(full.slice(4)).map((v) => v.toFixed(5)),
    );
    expect(Array.from(generateSchedule(0.25, 2)).map((v) => v.toFixed(5))).toEqual(
      Array.from(full.slice(6)).map((v) => v.toFixed(5)),
    );
  });

  it("only falls, and ends at 0", () => {
    for (const strength of [0.05, 0.3, 0.6, 0.8, 0.95]) {
      const sigmas = generateSchedule(strength);
      expect(sigmas[sigmas.length - 1]).toBe(0);
      for (let i = 1; i < sigmas.length; i++) expect(sigmas[i]).toBeLessThan(sigmas[i - 1]);
    }
  });
});

describe("Generate chunks", () => {
  it("runs a clip within the model's limit in one piece", () => {
    expect(generateChunks(200)).toEqual([[0, 200]]);
  });

  it("cuts a longer clip into overlapping runs within the limit that cover it", () => {
    const chunks = generateChunks(1000);
    expect(chunks[0][0]).toBe(0);
    expect(chunks[chunks.length - 1][1]).toBeCloseTo(1000, 6);
    for (const [start, end] of chunks) expect(end - start).toBeLessThanOrEqual(GENERATE_MAX_SECONDS);
    for (let i = 1; i < chunks.length; i++) expect(chunks[i][0]).toBeLessThan(chunks[i - 1][1]);
  });
});
