import { describe, expect, it, vi } from "vitest";

// parameters.ts sits in a cycle with the store, which builds its brush slice
// from these defs. Nothing here needs the store.
vi.mock("@renderer/store", () => ({ useStore: { getState: vi.fn() } }));

import { knownOpenRawChoices, openRawDefaults, type OpenRawSettings } from "../../store/open-raw";
import { formatRawDuration, rawDialogOutcome, rawOpenOptions } from "../raw-dialog";
import { RAW_MAX_SECONDS, RAW_RATE } from "../raw-file";

const GIGABYTE = 1 << 30;

const settings = (patch: Partial<OpenRawSettings> = {}): OpenRawSettings => ({ ...openRawDefaults(), ...patch });

describe("Open Raw dialog", () => {
  it("reads as many samples as fit in the longest file when Bytes is All", () => {
    expect(rawOpenOptions(settings(), GIGABYTE).length).toBe(RAW_MAX_SECONDS * RAW_RATE);
    expect(rawDialogOutcome(settings(), GIGABYTE)).toEqual({ seconds: RAW_MAX_SECONDS });
    const wide = settings({ rawFormat: "s16le", rawStereo: "separate" });
    expect(rawOpenOptions(wide, GIGABYTE).length).toBe(RAW_MAX_SECONDS * RAW_RATE * 4);
  });

  it("reads Speed times as many bytes on All, so the result stays at the longest length", () => {
    for (const speed of [0.25, 4]) {
      const fast = settings({ rawSpeed: speed });
      expect(rawOpenOptions(fast, GIGABYTE).length).toBe(RAW_MAX_SECONDS * RAW_RATE * speed);
      expect(rawDialogOutcome(fast, GIGABYTE)).toEqual({ seconds: RAW_MAX_SECONDS });
    }
  });

  it("runs as long as the bytes last at the format, stereo mode and speed", () => {
    expect(rawDialogOutcome(settings({ rawBytes: RAW_RATE * 30 }), GIGABYTE)).toEqual({ seconds: 30 });
    expect(rawDialogOutcome(settings({ rawFormat: "s16be", rawStereo: "separate" }), RAW_RATE * 4)).toEqual({
      seconds: 1,
    });
    expect(rawDialogOutcome(settings({ rawSpeed: 0.5 }), RAW_RATE)).toEqual({ seconds: 2 });
  });

  it("reads no more than the file holds", () => {
    expect(rawOpenOptions(settings({ rawBytes: 5000 }), 1000).length).toBe(1000);
  });

  it("passes Read, Hold Length and Remove Noise through", () => {
    const options = rawOpenOptions(settings({ rawRead: "hold", rawHoldLength: 255.6, rawRemoveNoise: 40 }), GIGABYTE);
    expect(options.read).toBe("hold");
    expect(options.holdLength).toBe(256);
    expect(options.removeNoise).toBeCloseTo(0.4);
    expect(rawOpenOptions(settings(), GIGABYTE).removeNoise).toBe(0);
  });

  it("names the field to change when the settings cannot open", () => {
    const problem = (patch: Partial<OpenRawSettings>, fileSize = GIGABYTE) => {
      const outcome = rawDialogOutcome(settings(patch), fileSize);
      return "problem" in outcome ? outcome.problem : null;
    };
    expect(problem({ rawBytes: RAW_MAX_SECONDS * RAW_RATE + 1 })).toMatch(/Bytes lower or Speed higher/);
    expect(problem({ rawFormat: "s16le", rawStereo: "separate", rawBytes: 3 })).toMatch(/Bytes higher/);
    expect(problem({}, 0)).toMatch(/Bytes higher/);
  });

  it("reads whole bytes when a log-scaled box leaves a count a hair off an integer", () => {
    expect(rawOpenOptions(settings({ rawBytes: 15121.999999999993 }), GIGABYTE).length).toBe(15122);
  });

  it("sets a saved choice the dialog no longer offers back to its default", () => {
    const stale = { ...settings({ rawSpeed: 2 }), rawRead: "jump", rawStereo: "offset" };
    expect(knownOpenRawChoices(stale)).toEqual({ rawRead: "plain", rawStereo: "mono" });
    expect(knownOpenRawChoices(settings({ rawRead: "hold", rawStereo: "split" }))).toEqual({});
  });

  it("shows lengths under a second in milliseconds", () => {
    expect(formatRawDuration(0.0125)).toBe("13 ms");
    expect(formatRawDuration(75.25)).toBe("1:15.3");
  });
});
