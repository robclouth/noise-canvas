import { describe, expect, it } from "vitest";

import manual from "../../../../../docs/manual.md?raw";
import { parseMarkdown, slugify, type MarkdownBlock } from "../markdown";

/**
 * The in-app manual viewer parses docs/manual.md with this, so the test is the
 * real document rather than fixtures: a construct the manual starts using that
 * the parser drops would otherwise show up as text quietly missing from help.
 */

const blocks = parseMarkdown(manual);

function ofKind<K extends MarkdownBlock["kind"]>(kind: K): Extract<MarkdownBlock, { kind: K }>[] {
  return blocks.filter((block): block is Extract<MarkdownBlock, { kind: K }> => block.kind === kind);
}

describe("slugify", () => {
  it("matches GitHub's heading anchors", () => {
    expect(slugify("Working with Ableton Live")).toBe("working-with-ableton-live");
    expect(slugify("How Modulation Amount Works")).toBe("how-modulation-amount-works");
    expect(slugify("Why Constant-Q")).toBe("why-constant-q");
  });
});

describe("parsing the manual", () => {
  it("finds every heading the file has", () => {
    const inSource = [...manual.matchAll(/^#{1,6}\s+(.+)$/gm)].map((m) => m[1].trim());
    expect(ofKind("heading").map((block) => block.text)).toEqual(inSource);
  });

  it("keeps table rows the same width as their header", () => {
    for (const table of ofKind("table")) {
      expect(table.header.length).toBeGreaterThan(0);
      for (const row of table.rows) expect(row.length).toBe(table.header.length);
    }
  });

  it("reads the tables the manual has", () => {
    // Warp algorithms, keyboard shortcuts, and the help surfaces.
    expect(ofKind("table").length).toBe(3);
  });

  it("never emits an empty list or a list item with no text", () => {
    for (const list of ofKind("list")) {
      expect(list.items.length).toBeGreaterThan(0);
      for (const item of list.items) expect(item.text.trim().length).toBeGreaterThan(0);
    }
  });

  it("leaves no block empty", () => {
    for (const block of blocks) {
      if (block.kind === "paragraph" || block.kind === "quote") expect(block.text.trim().length).toBeGreaterThan(0);
    }
  });

  it("consumes every non-blank line", () => {
    const rendered = blocks
      .map((block) => {
        switch (block.kind) {
          case "heading":
            return block.text;
          case "paragraph":
          case "quote":
          case "code":
            return block.text;
          case "list":
            return block.items.map((item) => `${item.text} ${item.children.join(" ")}`).join(" ");
          case "table":
            return [...block.header, ...block.rows.flat()].join(" ");
          case "rule":
            return "";
        }
      })
      .join(" ");

    // Every word of prose in the source has to survive into some block. Markers
    // and table pipes are structure rather than content.
    const words = manual
      .replace(/^[#>|\s-]+/gm, " ")
      .replace(/[|`*_[\]()#]/g, " ")
      .split(/\s+/)
      .filter((word) => word.length > 4);
    const missing = words.filter((word) => !rendered.includes(word));
    expect(missing).toEqual([]);
  });
});
