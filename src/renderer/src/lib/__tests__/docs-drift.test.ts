import { describe, expect, it, vi } from "vitest";

// parameters.ts sits in a cycle with the store; nothing here needs the store.
vi.mock("@renderer/store", () => ({ useStore: { getState: vi.fn() } }));

import manual from "../../../../../docs/manual.md?raw";
import recipes from "../../../../../docs/recipes.md?raw";
import { parameterDefs } from "../../parameters";
import { manualSectionForParameter } from "../ui-areas";
import { UI_AREA_NAMES, UI_TECHNIQUES, areasWithDeepTours, deepTourFor, getArea } from "../ui-areas";
import { UI_ANCHORS } from "../ui-anchors";

/**
 * Keeps the app and its documentation from drifting apart. Every help surface
 * derives from the area registry, so if a registry entry points at a manual
 * heading that no longer exists — or a screenshot that was never captured —
 * that is a broken deep link in the shipped build, and it fails here instead.
 */

/** Vite resolves this at build time, so it is a real listing of what is on disk. */
const screenshots = import.meta.glob("../../../../../docs/images/ui/*.webp");

const screenshotNames = new Set(
  Object.keys(screenshots).map((path) =>
    path
      .split("/")
      .pop()!
      .replace(/\.webp$/, ""),
  ),
);

/** GitHub's heading-anchor rule, which is also what the in-app viewer uses. */
function slugify(heading: string): string {
  return heading
    .toLowerCase()
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-");
}

const manualHeadings = new Set([...manual.matchAll(/^#{2,4}\s+(.+)$/gm)].map((match) => slugify(match[1].trim())));

const recipeIds = new Set([...recipes.matchAll(/^###\s+(.+)$/gm)].map((match) => slugify(match[1].trim())));

const areaNames = UI_AREA_NAMES;

describe("area registry", () => {
  it("covers every declared anchor", () => {
    expect(areaNames.slice().sort()).toEqual(UI_ANCHORS.slice().sort());
  });

  it.each(areaNames)("%s points at a manual heading that exists", (name) => {
    expect(manualHeadings).toContain(getArea(name).manualSection);
  });

  it.each(UI_TECHNIQUES.map((t) => [t.id, t] as const))("technique %s points at a real heading", (_id, technique) => {
    expect(manualHeadings).toContain(technique.manualSection);
  });

  it("demonstrates every technique on a declared anchor", () => {
    for (const technique of UI_TECHNIQUES) {
      expect(UI_ANCHORS).toContain(technique.demonstrateOn);
    }
  });

  it("only tags recipes that docs/recipes.md actually has", () => {
    const broken = areaNames.flatMap((name) =>
      (getArea(name).recipes ?? []).filter((recipe) => !recipeIds.has(recipe)).map((recipe) => `${name} → ${recipe}`),
    );
    expect(broken).toEqual([]);
  });

  it("gives every area a title and a blurb", () => {
    for (const name of areaNames) {
      const area = getArea(name);
      expect(area.title.length).toBeGreaterThan(0);
      expect(area.blurb.length).toBeGreaterThan(0);
      // The overlay lays these out as one line under the title.
      expect(area.blurb.length).toBeLessThanOrEqual(110);
    }
  });
});

describe("parameter deep links", () => {
  const resolved = Object.entries(parameterDefs)
    .map(([key, def]) => ({ key, section: manualSectionForParameter(key, def.effectType) }))
    .filter((entry): entry is { key: string; section: string } => entry.section !== null);

  it("resolves a section for most parameters", () => {
    // Only the generated modulation amounts should fall through; they are read
    // from the Modulation section as a whole rather than one heading each.
    const unresolved = Object.entries(parameterDefs).filter(
      ([key, def]) => manualSectionForParameter(key, def.effectType) === null,
    );
    const unexpected = unresolved.filter(([key]) => !/Mod\d|Mod[A-Z]|Macro\d/.test(key));
    expect(unexpected.map(([key]) => key)).toEqual([]);
  });

  it("only points at headings the manual actually has", () => {
    const broken = resolved.filter((entry) => !manualHeadings.has(entry.section));
    expect(broken.map((entry) => `${entry.key} → #${entry.section}`)).toEqual([]);
  });
});

describe("deep tours", () => {
  const withTours = areasWithDeepTours();

  it("has tours for the areas a tooltip can't explain", () => {
    expect(withTours.length).toBeGreaterThanOrEqual(3);
  });

  it.each(withTours)("%s only spotlights declared anchors", (name) => {
    for (const step of deepTourFor(name)) {
      if (step.anchor) expect(UI_ANCHORS).toContain(step.anchor);
    }
  });
});

// Skipped until `node scripts/capture-ui.mjs` has been run against this build;
// the images are regenerated wholesale rather than committed per change.
describe.skipIf(screenshotNames.size === 0)("screenshots", () => {
  it.each(areaNames)("%s has a captured screenshot", (name) => {
    expect(screenshotNames).toContain(name);
  });
});
