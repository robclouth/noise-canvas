import { Anchor, Blockquote, Code, Divider, List, Table, Text, Title } from "@mantine/core";
import { Fragment, type ReactNode } from "react";

/**
 * Renders the subset of Markdown docs/manual.md actually uses: headings,
 * paragraphs, bullet and numbered lists with one level of nesting, GFM tables,
 * blockquotes, fenced code, horizontal rules, and inline emphasis, code and
 * links. Output is React elements rather than HTML, so links stay ours to
 * route — in-document anchors scroll, external ones open in a browser.
 */

/**
 * Prose is read, not glanced at, so it sets its own sizes in pixels rather than
 * taking the theme's scale, which is tuned for dense control panels.
 */
const PROSE = 14;
const PROSE_SMALL = 13;
const PROSE_LH = 1.6;

export type MarkdownBlock =
  | { kind: "heading"; level: number; id: string; text: string }
  | { kind: "paragraph"; text: string }
  | { kind: "list"; ordered: boolean; items: { text: string; children: string[] }[] }
  | { kind: "table"; header: string[]; rows: string[][] }
  | { kind: "quote"; text: string }
  | { kind: "code"; text: string }
  | { kind: "rule" };

/** GitHub's heading-anchor rule, which the area registry's ids are written to. */
export function slugify(heading: string): string {
  return heading
    .toLowerCase()
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-");
}

function splitRow(line: string): string[] {
  return line
    .replace(/^\||\|$/g, "")
    .split("|")
    .map((cell) => cell.trim());
}

const TABLE_SEPARATOR = /^\|?[\s:-]+\|[\s|:-]*$/;

export function parseMarkdown(source: string): MarkdownBlock[] {
  const lines = source.split("\n");
  const blocks: MarkdownBlock[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (line.trim() === "") {
      i++;
      continue;
    }

    if (line.startsWith("```")) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith("```")) body.push(lines[i++]);
      i++;
      blocks.push({ kind: "code", text: body.join("\n") });
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      const text = heading[2].trim();
      blocks.push({ kind: "heading", level: heading[1].length, id: slugify(text), text });
      i++;
      continue;
    }

    if (/^---+$/.test(line.trim())) {
      blocks.push({ kind: "rule" });
      i++;
      continue;
    }

    if (line.startsWith("|") && TABLE_SEPARATOR.test(lines[i + 1] ?? "")) {
      const header = splitRow(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i].startsWith("|")) rows.push(splitRow(lines[i++]));
      blocks.push({ kind: "table", header, rows });
      continue;
    }

    if (line.startsWith(">")) {
      const body: string[] = [];
      while (i < lines.length && lines[i].startsWith(">")) body.push(lines[i++].replace(/^>\s?/, ""));
      blocks.push({ kind: "quote", text: body.join(" ").trim() });
      continue;
    }

    const bullet = line.match(/^(\s*)([-*]|\d+\.)\s+(.*)$/);
    if (bullet) {
      const ordered = !/^[-*]$/.test(bullet[2]);
      const items: { text: string; children: string[] }[] = [];
      while (i < lines.length) {
        const item = lines[i].match(/^(\s*)([-*]|\d+\.)\s+(.*)$/);
        if (!item) break;
        if (item[1].length > 0 && items.length > 0) {
          items[items.length - 1].children.push(item[3]);
        } else {
          items.push({ text: item[3], children: [] });
        }
        i++;
        // A wrapped continuation line is indented and carries no marker.
        while (i < lines.length && /^\s{2,}\S/.test(lines[i]) && !/^\s*([-*]|\d+\.)\s/.test(lines[i])) {
          const target = items[items.length - 1];
          if (target.children.length > 0) target.children[target.children.length - 1] += ` ${lines[i].trim()}`;
          else target.text += ` ${lines[i].trim()}`;
          i++;
        }
      }
      blocks.push({ kind: "list", ordered, items });
      continue;
    }

    const paragraph: string[] = [];
    while (i < lines.length && lines[i].trim() !== "" && !/^(#{1,6}\s|```|\||>|\s*([-*]|\d+\.)\s)/.test(lines[i])) {
      paragraph.push(lines[i++].trim());
    }
    blocks.push({ kind: "paragraph", text: paragraph.join(" ") });
  }

  return blocks;
}

type LinkHandler = (href: string) => void;

/** Matches, in one pass, the inline forms the manual uses. */
const INLINE = /(`[^`]+`)|(\[[^\]]+\]\([^)]+\))|(\*\*[^*]+\*\*)|(_[^_]+_)|(\*[^*]+\*)/g;

export function renderInline(text: string, onLink: LinkHandler): ReactNode {
  const parts: ReactNode[] = [];
  let last = 0;
  let key = 0;

  for (const match of text.matchAll(INLINE)) {
    const start = match.index;
    if (start > last) parts.push(text.slice(last, start));
    const token = match[0];

    if (token.startsWith("`")) {
      parts.push(
        // Relative, so inline code stays in proportion inside table cells too.
        <Code key={key++} fz="0.92em">
          {token.slice(1, -1)}
        </Code>,
      );
    } else if (token.startsWith("[")) {
      const [, label, href] = token.match(/^\[([^\]]+)\]\(([^)]+)\)$/) ?? [];
      parts.push(
        <Anchor
          key={key++}
          fz="inherit"
          onClick={(event) => {
            event.preventDefault();
            onLink(href);
          }}
        >
          {renderInline(label, onLink)}
        </Anchor>,
      );
    } else if (token.startsWith("**")) {
      parts.push(<strong key={key++}>{renderInline(token.slice(2, -2), onLink)}</strong>);
    } else {
      parts.push(<em key={key++}>{renderInline(token.slice(1, -1), onLink)}</em>);
    }

    last = start + token.length;
  }

  if (last < text.length) parts.push(text.slice(last));
  return parts.length === 1 ? parts[0] : parts.map((part, index) => <Fragment key={index}>{part}</Fragment>);
}

const HEADING_ORDER = [undefined, "h1", "h2", "h3", "h4", "h5", "h6"] as const;

export function renderBlocks(blocks: MarkdownBlock[], onLink: LinkHandler): ReactNode[] {
  return blocks.map((block, index) => {
    switch (block.kind) {
      case "heading":
        return (
          <Title
            key={index}
            id={block.id}
            order={Math.min(block.level, 6) as 1 | 2 | 3 | 4 | 5 | 6}
            size={HEADING_ORDER[Math.min(block.level + 1, 6)]}
            mt={block.level <= 2 ? "xl" : "md"}
            mb="xs"
            style={{ scrollMarginTop: 12 }}
          >
            {renderInline(block.text, onLink)}
          </Title>
        );

      case "paragraph":
        return (
          <Text key={index} fz={PROSE} lh={PROSE_LH} mb="sm">
            {renderInline(block.text, onLink)}
          </Text>
        );

      case "list":
        return (
          <List
            key={index}
            type={block.ordered ? "ordered" : "unordered"}
            fz={PROSE}
            lh={PROSE_LH}
            spacing={4}
            mb="sm"
            withPadding
          >
            {block.items.map((item, itemIndex) => (
              <List.Item key={itemIndex}>
                {renderInline(item.text, onLink)}
                {item.children.length > 0 && (
                  <List type={block.ordered ? "ordered" : "unordered"} fz={PROSE} spacing={2} mt={4} withPadding>
                    {item.children.map((child, childIndex) => (
                      <List.Item key={childIndex}>{renderInline(child, onLink)}</List.Item>
                    ))}
                  </List>
                )}
              </List.Item>
            ))}
          </List>
        );

      case "table":
        return (
          <Table key={index} striped highlightOnHover withTableBorder fz={PROSE_SMALL} mb="sm" layout="auto">
            <Table.Thead>
              <Table.Tr>
                {block.header.map((cell, cellIndex) => (
                  <Table.Th key={cellIndex}>{renderInline(cell, onLink)}</Table.Th>
                ))}
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {block.rows.map((row, rowIndex) => (
                <Table.Tr key={rowIndex}>
                  {row.map((cell, cellIndex) => (
                    <Table.Td key={cellIndex}>{renderInline(cell, onLink)}</Table.Td>
                  ))}
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        );

      case "quote":
        return (
          <Blockquote key={index} color="orange" p="xs" mb="sm" fz={PROSE} lh={PROSE_LH}>
            {renderInline(block.text, onLink)}
          </Blockquote>
        );

      case "code":
        return (
          <Code key={index} block fz={PROSE_SMALL} mb="sm">
            {block.text}
          </Code>
        );

      case "rule":
        return <Divider key={index} my="lg" />;
    }
  });
}
