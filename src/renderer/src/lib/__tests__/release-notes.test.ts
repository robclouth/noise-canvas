import { describe, expect, it } from "vitest";
import { stripDownloadTable } from "../release-notes";

// What the releases feed serves for a body built by scripts/release-notes.sh:
// the download table, a horizontal rule, then the notes.
const WITH_TABLE = `<h3>Downloads</h3>
<table><thead><tr><th>Platform</th><th>File</th></tr></thead>
<tbody><tr><td><strong>macOS, Apple Silicon</strong></td><td><a href="x">noise-canvas-mac-arm64.dmg</a> (138 MB)</td></tr></tbody></table>
<hr>
<p>A release about speed and memory.</p>
<h3>Faster</h3>
<ul><li>Painting is quicker.</li></ul>`;

describe("stripDownloadTable", () => {
  it("drops the table and everything above the rule", () => {
    const stripped = stripDownloadTable(WITH_TABLE);
    expect(stripped).not.toContain("<table");
    expect(stripped).not.toContain("Downloads");
    expect(stripped).not.toContain(".dmg");
    expect(stripped.startsWith("<p>A release about speed and memory.</p>")).toBe(true);
    expect(stripped).toContain("<h3>Faster</h3>");
  });

  it("leaves a body with no table alone", () => {
    const notes = "<p>A release about speed.</p>\n<hr>\n<p>More.</p>";
    expect(stripDownloadTable(notes)).toBe(notes);
  });

  it("leaves a body with no rule alone", () => {
    const notes = "<h3>Faster</h3>\n<ul><li>Painting is quicker.</li></ul>";
    expect(stripDownloadTable(notes)).toBe(notes);
  });

  it("keeps a table that sits below the rule, inside the notes", () => {
    const notes = "<p>Notes.</p>\n<hr>\n<table><tr><td>a</td></tr></table>";
    expect(stripDownloadTable(notes)).toBe(notes);
  });

  it("matches a self-closing rule", () => {
    expect(stripDownloadTable("<table><tr><td>a</td></tr></table><hr /><p>Notes.</p>")).toBe("<p>Notes.</p>");
  });
});
