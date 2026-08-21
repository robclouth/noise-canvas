import { describe, expect, it, vi } from "vitest";

// parameters.ts sits in a cycle with the store, which builds its brush slice
// from these defs. Nothing here needs the store.
vi.mock("@renderer/store", () => ({ useStore: { getState: vi.fn() } }));

import { parameterDefs } from "../../parameters";
import { EFFECT_DESCRIPTIONS, EFFECT_LABELS } from "../constants";

/**
 * The voice rule for every string a user reads next to a control: verb first,
 * present tense, naming the audible result. A description that opens with "The",
 * "Controls", or its own label costs a hover and gives nothing back — which is
 * what most of these used to do, so this is here to stop them drifting back.
 */

/** Openings that mean the sentence is about to describe itself, not the sound. */
const BANNED_OPENINGS = [/^the\b/i, /^controls\b/i, /^whether\b/i, /^how\b/i, /^a\b/i, /^an\b/i];

/** Effect picker cards are read while choosing, so they get a hard length cap. */
const EFFECT_MAX_LENGTH = 80;

const params = Object.values(parameterDefs);

/** Modulation-amount params are generated per source and named after it. */
function isGenerated(name: string): boolean {
  return / Mod \d+ Amount$| Mod [A-Za-z]+$| Macro \d+ Amount$/.test(name);
}

describe("parameter descriptions", () => {
  // A parameter whose description follows another's value carries one string
  // per value, and every one of them is read the same way.
  const authored = params
    .filter((p) => !isGenerated(p.name))
    .flatMap((p) => [
      p,
      ...Object.entries(p.descriptionBy?.descriptions ?? {}).map(([value, description]) => ({
        ...p,
        name: `${p.name} (${value})`,
        description,
      })),
    ]);

  it.each(authored.map((p) => [p.name, p.description] as const))("%s opens with a verb", (_name, description) => {
    for (const banned of BANNED_OPENINGS) expect(description).not.toMatch(banned);
  });

  it("never restates its own label", () => {
    const offenders = authored.filter((p) => {
      const label = p.label
        .toLowerCase()
        .replace(/[^a-z ]/g, "")
        .trim();
      if (label.length < 3) return false;
      // "Sets the scale's root note." for a label of "Tonic" is fine; the test
      // is for descriptions that are the label with articles bolted on.
      const stripped = p.description
        .toLowerCase()
        .replace(/[^a-z ]/g, "")
        .replace(/\b(the|a|an|of|to|for|this|its)\b/g, "")
        .replace(/\s+/g, " ")
        .trim();
      return stripped === label;
    });
    expect(offenders.map((p) => p.name)).toEqual([]);
  });

  it("ends every description with a full stop", () => {
    const offenders = authored.filter((p) => !p.description.trim().endsWith("."));
    expect(offenders.map((p) => p.name)).toEqual([]);
  });

  it("keeps every description under 300 characters", () => {
    const offenders = authored.filter((p) => p.description.length > 300);
    expect(offenders.map((p) => `${p.name} (${p.description.length})`)).toEqual([]);
  });
});

describe("effect descriptions", () => {
  const entries = Object.entries(EFFECT_DESCRIPTIONS);

  it("has one for every effect", () => {
    expect(Object.keys(EFFECT_DESCRIPTIONS).sort()).toEqual(Object.keys(EFFECT_LABELS).sort());
  });

  it.each(entries)("%s opens with a verb", (_key, description) => {
    for (const banned of BANNED_OPENINGS) expect(description).not.toMatch(banned);
  });

  it.each(entries)("%s fits on one line", (_key, description) => {
    expect(description.length).toBeLessThanOrEqual(EFFECT_MAX_LENGTH);
  });

  it.each(entries)("%s does not restate its label", (key, description) => {
    expect(description.toLowerCase().startsWith(EFFECT_LABELS[key].toLowerCase())).toBe(false);
  });
});
