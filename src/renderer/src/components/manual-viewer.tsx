import { Box, Modal, ScrollArea, TextInput } from "@mantine/core";
import { host } from "@renderer/lib/host";
import { ipcOn } from "@renderer/lib/ipc";
import { parseMarkdown, renderBlocks } from "@renderer/lib/markdown";
import { useStore } from "@renderer/store";
import { Search } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import manualSource from "../../../../docs/manual.md?raw";

/**
 * The manual, rendered in-app from the copy bundled with this build. It ships
 * inside the JS bundle rather than as a loose resource, so help is offline,
 * always describes this binary, and can't go missing from the package.
 */

/** Filters to the sections whose heading or body mentions the query. */
function filterSource(source: string, query: string): string {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return source;

  const sections: string[][] = [];
  let current: string[] = [];
  for (const line of source.split("\n")) {
    if (/^#{2,4}\s/.test(line) && current.length > 0) {
      sections.push(current);
      current = [];
    }
    current.push(line);
  }
  sections.push(current);

  const matched = sections.filter((section) => section.join("\n").toLowerCase().includes(needle));
  return matched.length > 0 ? matched.map((section) => section.join("\n")).join("\n") : "";
}

export function ManualViewer(): React.JSX.Element {
  const section = useStore((state) => state.manualSection);
  const closeManual = useStore((state) => state.closeManual);
  const openManual = useStore((state) => state.openManual);
  const [query, setQuery] = useState("");
  const bodyRef = useRef<HTMLDivElement>(null);

  const opened = section !== null;

  const blocks = useMemo(() => parseMarkdown(filterSource(manualSource, query)), [query]);

  const handleLink = useCallback(
    (href: string) => {
      if (href.startsWith("#")) {
        openManual(href.slice(1));
        return;
      }
      // Relative links point at repo files that aren't in the package; send
      // people to the published copy rather than navigating the window.
      const url = href.startsWith("http")
        ? href
        : `https://github.com/robclouth/noise-canvas/blob/main/${href.replace(/^\.\//, "")}`;
      host.shell.openExternal(url);
    },
    [openManual],
  );

  const content = useMemo(() => renderBlocks(blocks, handleLink), [blocks, handleLink]);

  // Scrolling has to wait for the filtered body to render, and again for
  // Mantine's modal transition to have laid the viewport out.
  useEffect(() => {
    if (!opened || !section) return;
    let cancelled = false;
    const scroll = () => {
      if (cancelled) return;
      const target = bodyRef.current?.querySelector(`#${CSS.escape(section)}`);
      if (target) target.scrollIntoView({ block: "start" });
    };
    const frame = requestAnimationFrame(() => requestAnimationFrame(scroll));
    return () => {
      cancelled = true;
      cancelAnimationFrame(frame);
    };
  }, [opened, section, content]);

  useEffect(() => {
    if (!opened) setQuery("");
  }, [opened]);

  // Help → Manual, and the same accelerator from the menu.
  useEffect(() => {
    return ipcOn("open-manual", (section) => openManual(typeof section === "string" ? section : undefined));
  }, [openManual]);

  return (
    <Modal
      opened={opened}
      onClose={closeManual}
      title="Manual"
      size="xl"
      scrollAreaComponent={ScrollArea.Autosize}
      styles={{ body: { paddingTop: 0 } }}
    >
      <Box pos="sticky" top={0} bg="var(--mantine-color-body)" pt={4} pb="sm" style={{ zIndex: 1 }}>
        <TextInput
          placeholder="Search the manual…"
          leftSection={<Search size={14} />}
          value={query}
          onChange={(event) => setQuery(event.currentTarget.value)}
          size="xs"
        />
      </Box>
      <Box ref={bodyRef}>{content}</Box>
    </Modal>
  );
}
