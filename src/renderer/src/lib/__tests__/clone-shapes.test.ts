import { activeClonePasses, buildShapeTable } from "@renderer/effects/clone-shapes";
import { syncEffects } from "@renderer/effects/types";
import { describe, expect, it } from "vitest";

// Tables are in Space units. On the pitch axis one unit is the Space ↕ value,
// so a table entry of 1 with Space ↕ = 12 lands an octave up.
const SEMIS_PER_UNIT = 12;

function semitones(shape: Parameters<typeof buildShapeTable>[0], count: number, tonic = "C", type = "major"): number[] {
  return buildShapeTable(shape, count, tonic, type).map((step) => step * SEMIS_PER_UNIT);
}

describe("clone shape tables", () => {
  it("starts every shape on the dry copy", () => {
    for (const shape of ["even", "harmonic", "geometric", "inharmonic", "scale"] as const) {
      expect(semitones(shape, 8)[0]).toBeCloseTo(0, 6);
    }
  });

  it("puts the first copy one Space value out, except on the scale", () => {
    for (const shape of ["even", "harmonic", "geometric", "inharmonic"] as const) {
      expect(semitones(shape, 8)[1]).toBeCloseTo(SEMIS_PER_UNIT, 6);
    }
  });

  it("spaces the harmonic shape by the natural harmonic series", () => {
    const taps = semitones("harmonic", 8);
    // Partials 2, 3, 4 and 5 of a fundamental, in semitones.
    expect(taps[1]).toBeCloseTo(12, 3);
    expect(taps[2]).toBeCloseTo(19.0196, 3);
    expect(taps[3]).toBeCloseTo(24, 3);
    expect(taps[4]).toBeCloseTo(27.8631, 3);
  });

  it("doubles every gap on the geometric shape", () => {
    const taps = semitones("geometric", 6);
    const gaps = taps.slice(1).map((tap, i) => tap - taps[i]);
    for (let i = 1; i < gaps.length; i++) {
      expect(gaps[i]).toBeCloseTo(gaps[i - 1] * 2, 3);
    }
  });

  it("keeps the geometric shape finite at the highest count", () => {
    for (const tap of semitones("geometric", 64)) {
      expect(Number.isFinite(tap)).toBe(true);
    }
  });

  it("stretches the inharmonic shape sharp of the harmonic one", () => {
    const harmonic = semitones("harmonic", 32);
    const inharmonic = semitones("inharmonic", 32);
    for (let i = 2; i < harmonic.length; i++) {
      expect(inharmonic[i]).toBeGreaterThan(harmonic[i]);
    }
    expect(inharmonic[31] - harmonic[31]).toBeGreaterThan(1);
  });

  it("follows the selected scale's degrees", () => {
    expect(semitones("scale", 8)).toEqual([0, 2, 4, 5, 7, 9, 11, 12]);
  });

  it("spaces the even shape by one Space value per copy", () => {
    expect(semitones("even", 5)).toEqual([0, 12, 24, 36, 48]);
  });
});

describe("clone pass skipping", () => {
  it("runs both passes when both axes have copies", () => {
    expect(activeClonePasses(4, 4)).toEqual([0, 1]);
  });

  it("drops the time pass for a pitch-only stack", () => {
    expect(activeClonePasses(1, 16)).toEqual([1]);
  });

  it("drops the pitch pass for a time-only echo", () => {
    expect(activeClonePasses(6, 1)).toEqual([0]);
  });

  it("keeps one pass when a single copy stamps the source", () => {
    expect(activeClonePasses(1, 1)).toEqual([0]);
  });
});

describe("overtones migration", () => {
  it("rewrites a saved overtones effect onto clone", () => {
    const [migrated] = syncEffects([
      {
        id: "old",
        effect: "overtones",
        enabled: true,
        params: { overtonesCount: 16, overtonesShape: "logarithmic", overtonesDecay: 60, overtonesScale: 1 },
      },
    ]);

    expect(migrated.effect).toBe("clone");
    expect(migrated.enabled).toBe(true);
    expect(migrated.params).toMatchObject({
      cloneCountX: 1,
      cloneCountY: 16,
      cloneSpaceSemis: 12,
      cloneShapeY: "harmonic",
      cloneDirectionY: 0,
      cloneDecay: 60,
      cloneSumMode: 1,
    });
  });

  it("maps the old octaves shape onto even spacing", () => {
    const [migrated] = syncEffects([
      { id: "old", effect: "overtones", enabled: true, params: { overtonesShape: "octaves", overtonesScale: 2 } },
    ]);

    expect(migrated.params).toMatchObject({ cloneShapeY: "even", cloneSpaceSemis: 24 });
  });
});
