import { Box, Divider, Modal, ScrollArea, Text, TextInput, UnstyledButton } from "@mantine/core";
import { host } from "@renderer/lib/host";
import { ipcOn } from "@renderer/lib/ipc";
import { parseMarkdown, renderBlocks } from "@renderer/lib/markdown";
import { useStore } from "@renderer/store";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import manualSource from "../../../../docs/manual.md?raw";

/**
 * The manual, rendered in-app from the copy bundled with this build. It ships
 * inside the JS bundle rather than as a loose resource, so help is offline,
 * always describes this binary, and can't go missing from the package.
 */

/** Above the transport and the app's own modals, which both sit at 1000. */
const MANUAL_Z = 10004;
const NAV_WIDTH = 210;
const NAV_TEXT_SIZE = 12;
/** Around 75 characters a line at the prose size, which is where reading is easiest. */
const BODY_WIDTH = 680;
const HEIGHT = "86vh";
/** Breathing room above a heading the viewer has jumped to. */
const HEADING_INSET = 8;

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
  const [activeId, setActiveId] = useState<string | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);

  const opened = section !== null;

  const blocks = useMemo(() => parseMarkdown(filterSource(manualSource, query)), [query]);

  /** The contents tree: top-level sections with their subsections nested. */
  const contents = useMemo(
    () =>
      blocks
        .filter((block) => block.kind === "heading" && block.level >= 2 && block.level <= 3)
        .map((block) => (block.kind === "heading" ? { id: block.id, text: block.text, level: block.level } : null))
        .filter((entry): entry is { id: string; text: string; level: number } => entry !== null)
        // The manual's own Contents section duplicates this nav.
        .filter((entry) => entry.id !== "contents"),
    [blocks],
  );

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

  // Corrects by the measured gap rather than calling scrollIntoView, which
  // would also scroll every ancestor, and repeats a few times so a heading that
  // shifts as the modal settles is followed rather than missed. Each pass
  // measures afresh, so it converges and then does nothing.
  useEffect(() => {
    if (!opened || !section) return;
    const timers: number[] = [];
    const align = () => {
      const viewport = viewportRef.current;
      const target = bodyRef.current?.querySelector(`#${CSS.escape(section)}`);
      if (!viewport || !target) return;
      const delta = target.getBoundingClientRect().top - viewport.getBoundingClientRect().top;
      if (Math.abs(delta) > 1) viewport.scrollTop += delta - HEADING_INSET;
      setActiveId(section);
    };
    const frame = requestAnimationFrame(align);
    for (const delay of [80, 200, 400]) timers.push(window.setTimeout(align, delay));
    return () => {
      cancelAnimationFrame(frame);
      for (const timer of timers) window.clearTimeout(timer);
    };
  }, [opened, section, content]);

  useEffect(() => {
    if (!opened) setQuery("");
  }, [opened]);

  // Help → Manual, and the same accelerator from the menu.
  useEffect(() => {
    return ipcOn("open-manual", (target) => openManual(typeof target === "string" ? target : undefined));
  }, [openManual]);

  /** Marks the last heading scrolled past, so the nav tracks where you are. */
  const trackPosition = useCallback(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const headings = bodyRef.current?.querySelectorAll<HTMLElement>("h1, h2, h3, h4");
    if (!headings) return;
    const top = viewport.getBoundingClientRect().top;
    let current: string | null = null;
    for (const heading of headings) {
      if (heading.getBoundingClientRect().top - top > 24) break;
      if (heading.id) current = heading.id;
    }
    setActiveId(current);
  }, []);

  return (
    <Modal
      opened={opened}
      onClose={closeManual}
      title="Manual"
      // Wide enough for the nav beside a full-width column of prose, and no
      // wider, so the text isn't stranded against an empty half of the modal.
      size={`min(${NAV_WIDTH + BODY_WIDTH + 80}px, 92vw)`}
      zIndex={MANUAL_Z}
      // The body fills whatever the header leaves rather than a guessed offset,
      // so the two panes own the only scrollbars and nothing overflows the frame.
      styles={{
        content: { height: HEIGHT, display: "flex", flexDirection: "column", overflow: "hidden" },
        header: { flexShrink: 0 },
        body: { flex: 1, minHeight: 0, padding: 0, display: "flex", overflow: "hidden" },
      }}
    >
      <Box w={NAV_WIDTH} style={{ flexShrink: 0, display: "flex", flexDirection: "column" }} pl="md" pb="md">
        <TextInput
          placeholder="Search the manual…"
          value={query}
          onChange={(event) => setQuery(event.currentTarget.value)}
          size="xs"
          mb="xs"
        />
        <ScrollArea scrollbarSize={4} type="auto" style={{ flex: 1, minHeight: 0 }}>
          {contents.map((entry) => (
            <UnstyledButton
              key={entry.id}
              w="100%"
              px={entry.level === 3 ? "md" : "xs"}
              py={2}
              onClick={() => openManual(entry.id)}
            >
              <Text
                fz={NAV_TEXT_SIZE}
                fw={entry.level === 2 ? 600 : 400}
                c={activeId === entry.id ? "orange.4" : entry.level === 2 ? "gray.3" : "dimmed"}
                truncate
              >
                {entry.text}
              </Text>
            </UnstyledButton>
          ))}
          {contents.length === 0 && (
            <Text fz={NAV_TEXT_SIZE} c="dimmed" px="xs">
              Nothing matches “{query}”.
            </Text>
          )}
        </ScrollArea>
      </Box>

      <Divider orientation="vertical" />

      <ScrollArea
        viewportRef={viewportRef}
        onScrollPositionChange={trackPosition}
        scrollbarSize={6}
        type="auto"
        style={{ flex: 1, minWidth: 0 }}
        px="lg"
        pb="md"
      >
        <Box ref={bodyRef} maw={BODY_WIDTH}>
          {content}
        </Box>
      </ScrollArea>
    </Modal>
  );
}
