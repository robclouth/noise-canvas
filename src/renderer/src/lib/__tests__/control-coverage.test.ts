import { describe, expect, it } from "vitest";

import manual from "../../../../../docs/manual.md?raw";
import { UI_CONTROLS, UI_CONTROL_NAMES, type UiControlName } from "../ui-controls";

/**
 * Every control in the main interface must carry help. A button that ships
 * without it has no tooltip and cannot be found in the help overlay, which is
 * how the interface got to 44 buttons and 16 tooltips in the first place. This
 * fails the build instead of leaving that to be noticed.
 */

/** Vite inlines these at build time, so the scan reads what is actually on disk. */
const sources = import.meta.glob("../../components/**/*.tsx", {
  query: "?raw",
  eager: true,
  import: "default",
}) as Record<string, string>;

/**
 * Surfaces that are not the main interface. Each is excluded for a reason, not
 * because it was missed: a dialog explains itself in its own body text, and the
 * help surfaces cannot describe themselves from inside the registry.
 */
const OUT_OF_SCOPE = [
  "components/modals.tsx", // app dialogs — their own body text is the explanation
  "components/image-export-modal.tsx", // dialog
  "components/update-notification.tsx", // dialog
  "components/manual-viewer.tsx", // a help surface
  "components/help-overlay.tsx", // a help surface
  "components/empty-state.tsx", // its body text is the explanation
  "components/controls/help-control.tsx", // defines the wrappers
  "components/controls/brush-picker.tsx", // dialog
  "components/layout/menu-bar.tsx", // menu titles, described under Menus in the manual
];

const MEASURED = Object.entries(sources).filter(
  ([path]) => !OUT_OF_SCOPE.some((skip) => path.endsWith(skip.replace("components/", ""))),
);

/** The opening tag starting at `start`, brace- and quote-aware. */
function openingTag(source: string, start: number): string {
  let depth = 0;
  let quote: string | null = null;
  for (let i = start; i < source.length; i++) {
    const char = source[i];
    if (quote) {
      if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'" || char === "`") quote = char;
    else if (char === "{") depth++;
    else if (char === "}") depth--;
    else if (char === ">" && depth === 0) return source.slice(start, i + 1);
  }
  return source.slice(start);
}

const BUTTON_TAG = /<(ActionIcon|Button|UnstyledButton)\b/g;

describe("control help coverage", () => {
  it("every button in the main interface carries help", () => {
    const uncovered: string[] = [];

    for (const [path, source] of MEASURED) {
      for (const match of source.matchAll(BUTTON_TAG)) {
        const tag = openingTag(source, match.index);
        if (tag.includes("helpProps(")) continue;
        // Rendered as a plain element, so it is styling rather than a control:
        // whatever wraps it is the thing you can actually press.
        if (/component="(div|span)"/.test(tag)) continue;
        const line = source.slice(0, match.index).split("\n").length;
        uncovered.push(`${path.replace("../../", "")}:${line} <${match[1]}>`);
      }
    }

    expect(uncovered, "wrap these in HelpActionIcon/HelpButton, or spread helpProps(name) onto them").toEqual([]);
  });

  it("every registry entry is used by a control", () => {
    const text = Object.values(sources).join("\n");
    const unused = UI_CONTROL_NAMES.filter((name) => !text.includes(`"${name}"`));
    expect(unused, "these entries name no control in the interface").toEqual([]);
  });

  it("every slug used in the interface is in the registry", () => {
    const unknown = new Set<string>();
    for (const source of Object.values(sources)) {
      for (const match of source.matchAll(/helpProps\("([^"]+)"\)|help="([^"]+)"/g)) {
        const slug = match[1] ?? match[2];
        if (!(slug in UI_CONTROLS)) unknown.add(slug);
      }
    }
    expect([...unknown]).toEqual([]);
  });

  it("every control points at a manual heading that exists", () => {
    const headings = new Set(
      [...manual.matchAll(/^#{2,4}\s+(.*)$/gm)].map(([, text]) =>
        text
          .trim()
          .toLowerCase()
          .replace(/[^\w\s-]/g, "")
          .trim()
          .replace(/\s+/g, "-"),
      ),
    );

    const broken = UI_CONTROL_NAMES.map((name) => ({ name, section: UI_CONTROLS[name].manualSection }))
      .filter((entry) => entry.section && !headings.has(entry.section))
      .map((entry) => `${entry.name} -> #${entry.section}`);

    expect(broken).toEqual([]);
  });

  it("descriptions are one sentence, in the parameters' voice", () => {
    const BANNED_OPENING = /^(the|a|an|controls|whether|how)\b/i;
    const wrong: string[] = [];

    for (const name of UI_CONTROL_NAMES) {
      const { label, description } = UI_CONTROLS[name as UiControlName];
      if (!description.endsWith(".")) wrong.push(`${name}: no full stop`);
      if (BANNED_OPENING.test(description)) wrong.push(`${name}: opens with "${description.split(" ")[0]}"`);
      if (description.split(". ").length > 1) wrong.push(`${name}: more than one sentence`);
      if (label.endsWith(".")) wrong.push(`${name}: label is not a sentence`);
    }

    expect(wrong).toEqual([]);
  });
});
