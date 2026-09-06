import { describe, expect, it } from "vitest";

import { createConstantQMockSpectrogramData } from "../../test/mock-spectrogram";
import { createMockState, createMockStateWithSteps, type TestBrushStep } from "../../test/mock-state";
import { impulseKey } from "../impulse-key";
import { impulseNeeds, type ResponseFile } from "../impulse-need";

const RESPONSE = { path: "/response.wav", name: "response.wav" };
const SOURCE = { path: "/source.wav", name: "source.wav" };

// Bands two to an octave over two and a half octaves, so the coarsest of them
// covers four frames and a tap steps the read through the response by four.
const SAMPLE_RATE = 256;
const NUM_FRAMES = 1024;
const STRIDE = 4;

function fileFor(id: string): ResponseFile {
  return {
    id,
    spectrogramData: createConstantQMockSpectrogramData({
      durationSeconds: NUM_FRAMES / SAMPLE_RATE,
      sampleRate: SAMPLE_RATE,
      bandsPerOctave: 2,
    }),
  };
}

/** Names each file by the path asked for, so a need says which one it came from. */
function resolve(path: string | null): ResponseFile | null {
  return fileFor(path ?? "this-file");
}

function stepWith(params: Record<string, unknown>, overrides: Partial<TestBrushStep> = {}): Partial<TestBrushStep> {
  return { ...overrides, effects: [{ id: "convolve-1", effect: "convolve", enabled: true, params }] };
}

function needsOf(...steps: Array<Partial<TestBrushStep>>) {
  return impulseNeeds(
    createMockStateWithSteps(steps.map((overrides, i) => ({ name: `Step ${i}`, overrides }))),
    resolve,
  );
}

describe("the coarsest bin a mock file stores", () => {
  it("is the stride the tap spans below are measured in", () => {
    const { synthesisMetadata } = fileFor("x").spectrogramData;
    expect(1 << Math.max(...synthesisMetadata.bandStepLog2s)).toBe(STRIDE);
  });
});

describe("impulseNeeds", () => {
  it("finds nothing in a brush with no convolve step", () => {
    expect(needsOf({})).toEqual([]);
  });

  it("ignores a convolve that is switched off", () => {
    const step = { effects: [{ id: "off", effect: "convolve", enabled: false, params: {} }] };
    expect(needsOf(step)).toEqual([]);
  });

  it("runs the taps forward from IR Start, one response bin each", () => {
    const [entry] = needsOf(stepWith({ convolveIrFile: RESPONSE, convolveIrSize: 16, convolveIrTimeOffset: 25 }));
    expect(entry.key).toBe(RESPONSE.path);
    expect(entry.need).toEqual({
      fileId: RESPONSE.path,
      startFrame: NUM_FRAMES / 4,
      endFrame: NUM_FRAMES / 4 + 16 * STRIDE,
      wantOriginal: false,
    });
  });

  it("stops at the response's last frame", () => {
    const [entry] = needsOf(stepWith({ convolveIrFile: RESPONSE, convolveIrSize: 512, convolveIrTimeOffset: 90 }));
    expect(entry.need.endFrame).toBe(NUM_FRAMES);
  });

  it("filters through the file the step paints from when it names no response", () => {
    const [entry] = needsOf(stepWith({ convolveIrSize: 16 }, { sourceFile: SOURCE }));
    expect(entry.key).toBe(SOURCE.path);
    expect(entry.need.fileId).toBe(SOURCE.path);
  });

  it("filters through the file it paints on when the step names neither", () => {
    const [entry] = needsOf(stepWith({ convolveIrSize: 16 }));
    expect(entry.key).toBe("");
    expect(entry.need.fileId).toBe("this-file");
  });

  it("reads every step of the brush, not only the active one", () => {
    expect(needsOf({}, stepWith({ convolveIrFile: RESPONSE })).map((entry) => entry.key)).toEqual([RESPONSE.path]);
  });

  it("gives one response the frames every step asking for it reads", () => {
    const entries = needsOf(
      stepWith({ convolveIrFile: RESPONSE, convolveIrSize: 8, convolveIrTimeOffset: 50 }),
      stepWith({ convolveIrFile: RESPONSE, convolveIrSize: 8, convolveIrTimeOffset: 25 }),
    );
    expect(entries).toHaveLength(1);
    expect(entries[0].need.startFrame).toBe(NUM_FRAMES / 4);
    expect(entries[0].need.endFrame).toBe(NUM_FRAMES / 2 + 8 * STRIDE);
  });

  it("keeps two responses apart", () => {
    const entries = needsOf(stepWith({ convolveIrFile: RESPONSE }), stepWith({}, { sourceFile: SOURCE }));
    expect(entries.map((entry) => entry.key)).toEqual([RESPONSE.path, SOURCE.path]);
  });

  it("passes over a response no open file answers for", () => {
    const state = createMockStateWithSteps([{ name: "Step", overrides: stepWith({ convolveIrFile: RESPONSE }) }]);
    expect(impulseNeeds(state, () => null)).toEqual([]);
  });
});

describe("impulseKey", () => {
  it("names the response file, then the file painted from, then this file", () => {
    expect(impulseKey(createMockState({ convolveIrFile: RESPONSE, sourceFile: SOURCE }))).toBe(RESPONSE.path);
    expect(impulseKey(createMockState({ sourceFile: SOURCE }))).toBe(SOURCE.path);
    expect(impulseKey(createMockState({}))).toBe("");
  });
});
