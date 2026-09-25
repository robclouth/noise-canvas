import { describe, expect, it } from "vitest";

/**
 * Keeps the two coordinate spaces apart.
 *
 * A canvas may hold the whole file or one window of it, so a packed pixel
 * range, a UV and a frame count each mean one thing against the file and
 * another against the canvas. Confusing them is silent: the paint lands in the
 * wrong place, or a commit stores zeros. The rule that keeps it findable is
 *
 *   the stroke renderer speaks the canvas's space,
 *   everything above it speaks the file's,
 *   and only the files listed here convert between them.
 *
 * If this test fails, a new file started translating. Either move that work
 * into `windowed-canvas.ts`, or add the file here and say why it belongs.
 */

/** Vite resolves these at build time, so it is a real listing of what is on disk. */
const sources = import.meta.glob("../../**/*.{ts,tsx}", { query: "?raw", import: "default", eager: true });

/** Turns a helper in canvas-view.ts from one space into the other. */
const TRANSLATORS = [
  "clipRangesToView",
  "composeViewContent",
  "fileRangesToView",
  "fileUvToViewUv",
  "viewRangesLeaving",
  "viewRangesToFile",
  "viewUvToFileUv",
];

const ALLOWED = new Map([
  ["windowed-canvas.ts", "the boundary itself: the file-space face of the canvas"],
  ["carried-paint.ts", "names the pixels a stroke painted on blocks leaving the window"],
  ["block-slot-cache.ts", "places a block's own pixels inside the view it composes into"],
  ["self-window.ts", "lays paint the store lacks over the window of the file it composes"],
]);

/** The glob's keys are relative to this file; drop the climb out of it. */
function moduleName(path: string): string {
  return path.replace(/^(\.\.?\/)+/, "");
}

describe("the file and canvas coordinate spaces", () => {
  it("is converted between in the boundary files alone", () => {
    const offenders: string[] = [];
    for (const [path, source] of Object.entries(sources)) {
      const name = moduleName(path);
      if (name.endsWith(".test.ts") || name === "canvas-view.ts" || ALLOWED.has(name)) continue;
      const used = TRANSLATORS.filter((fn) => new RegExp(`\\b${fn}\\s*\\(`).test(source as string));
      if (used.length > 0) offenders.push(`${name} calls ${used.join(", ")}`);
    }
    expect(offenders).toEqual([]);
  });

  it("lists only files that still exist", () => {
    const names = new Set(Object.keys(sources).map(moduleName));
    for (const allowed of ALLOWED.keys()) expect(names.has(allowed), `${allowed} is listed but gone`).toBe(true);
  });
});
