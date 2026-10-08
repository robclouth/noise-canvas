import { ActionIcon, Box, Button, Group, Loader, Stack, Text } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import type { ContextModalProps } from "@mantine/modals";
import { rerollRandomColormap } from "@renderer/lib/image-export-colormaps";
import { ASPECTS, canvasToPngBytes, computeImageSize, type ImageExportOptions } from "@renderer/lib/image-export";
import type { PosterInfo } from "@renderer/lib/image-export-poster";
import { host } from "@renderer/lib/host";
import { openContextModal } from "@renderer/lib/modals";
import { useStore } from "@renderer/store";
import { openFiles } from "@renderer/store/files";
import { isManagedFilePath } from "@renderer/store/utils";
import { Dices } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useShallow } from "zustand/shallow";
import { DialogControls } from "./dialog-controls";
import { Tooltip } from "./tooltip";

/** Long edge of the preview render. Covers a retina preview box without lag. */
const PREVIEW_LONG_EDGE = 960;
const PREVIEW_DEBOUNCE_MS = 120;

/** Opens the export dialog for one file. Driven by File → Export Image. */
// eslint-disable-next-line react-refresh/only-export-components
export function openImageExportModal(fileId: string): void {
  openContextModal({ modal: "imageExport", title: "Export Image", size: "md", innerProps: { fileId } });
}

/** The caption for the poster layout. */
function buildPosterInfo(fileId: string): PosterInfo | null {
  const file = openFiles[fileId];
  if (!file?.spectrogramData) return null;
  return { title: file.displayName };
}

/** Where the save dialog starts: alongside the audio file, or in the home folder. */
function defaultImagePath(fileId: string): string {
  const file = openFiles[fileId];
  const name = `${file.displayName.replace(/\.[^.]+$/, "")}.png`;
  if (isManagedFilePath(file.filePath)) return host.path.join(host.os.homedir(), name);
  return host.path.join(host.path.dirname(file.filePath), name);
}

export const ImageExportModal = ({ context, id, innerProps: { fileId } }: ContextModalProps<{ fileId: string }>) => {
  const options: ImageExportOptions = useStore(
    useShallow((state) => ({
      colormap: state.imageExportColour,
      aspect: state.imageExportShape,
      size: state.imageExportSize,
      poster: state.imageExportPoster,
    })),
  );
  const [rendering, setRendering] = useState(true);
  const [exporting, setExporting] = useState(false);
  // Bumped on every new Random ramp, so the preview redraws with it.
  const [paletteVersion, setPaletteVersion] = useState(0);
  const previewRef = useRef<HTMLDivElement>(null);

  const reroll = useCallback(() => {
    rerollRandomColormap();
    setPaletteVersion((version) => version + 1);
  }, []);

  // Picking Random rolls a new ramp; opening the dialog on Random keeps the current one.
  const shownColormap = useRef(options.colormap);
  useEffect(() => {
    if (options.colormap === shownColormap.current) return;
    shownColormap.current = options.colormap;
    if (options.colormap === "random") reroll();
  }, [options.colormap, reroll]);

  const ratio = (ASPECTS.find((a) => a.id === options.aspect) ?? ASPECTS[0]).ratio;
  const full = computeImageSize(ratio, options.size);

  // Re-render the preview whenever an option changes. A generation counter
  // drops the result of any render that a newer change has superseded.
  const generationRef = useRef(0);
  useEffect(() => {
    const generation = ++generationRef.current;
    setRendering(true);
    const timer = window.setTimeout(async () => {
      const renderer = openFiles[fileId]?.rendererRef?.current;
      const posterInfo = buildPosterInfo(fileId);
      if (!renderer || !posterInfo) {
        setRendering(false);
        return;
      }
      try {
        const canvas = await renderer.renderExportImage({ ...options, size: PREVIEW_LONG_EDGE }, posterInfo);
        if (generation !== generationRef.current) return;
        const container = previewRef.current;
        if (canvas && container) {
          canvas.style.display = "block";
          canvas.style.maxWidth = "100%";
          canvas.style.maxHeight = "304px";
          canvas.style.width = "auto";
          canvas.style.height = "auto";
          canvas.style.borderRadius = "2px";
          container.replaceChildren(canvas);
        }
      } finally {
        if (generation === generationRef.current) setRendering(false);
      }
    }, PREVIEW_DEBOUNCE_MS);

    return () => window.clearTimeout(timer);
  }, [fileId, options, paletteVersion]);

  const handleExport = useCallback(async () => {
    const renderer = openFiles[fileId]?.rendererRef?.current;
    const posterInfo = buildPosterInfo(fileId);
    if (!renderer || !posterInfo) return;

    const result = await host.dialogs.showSaveDialog({
      title: "Export Image",
      defaultPath: defaultImagePath(fileId),
      filters: [{ name: "PNG Image", extensions: ["png"] }],
    });
    if (result.canceled || !result.filePath) return;

    setExporting(true);
    const notificationId = `image-export-${fileId}`;
    notifications.show({
      id: notificationId,
      title: "Exporting image",
      message: `${full.width} × ${full.height}`,
      loading: true,
      autoClose: false,
      withCloseButton: false,
    });

    try {
      const canvas = await renderer.renderExportImage(options, posterInfo);
      if (!canvas) throw new Error("The view is not ready to export yet");
      await host.fs.writeFile(result.filePath, await canvasToPngBytes(canvas));
      notifications.update({
        id: notificationId,
        title: "Image exported",
        message: host.path.basename(result.filePath),
        loading: false,
        autoClose: 4000,
        withCloseButton: true,
      });
      context.closeModal(id);
    } catch (error) {
      notifications.update({
        id: notificationId,
        title: "Export failed",
        message: error instanceof Error ? error.message : String(error),
        loading: false,
        autoClose: 6000,
        withCloseButton: true,
        color: "red",
      });
    } finally {
      setExporting(false);
    }
  }, [context, fileId, full.height, full.width, id, options]);

  return (
    <Stack gap="sm">
      <Box
        style={{
          position: "relative",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          height: 320,
          padding: 8,
          borderRadius: "var(--mantine-radius-sm)",
          backgroundColor: "var(--mantine-color-dark-8)",
          overflow: "hidden",
        }}
      >
        <div ref={previewRef} style={{ display: "flex", alignItems: "center", justifyContent: "center" }} />
        {rendering && (
          <Box style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center" }}>
            <Loader size="sm" color="dark.2" />
          </Box>
        )}
      </Box>

      <DialogControls keys={["imageExportColour", "imageExportShape", "imageExportSize", "imageExportPoster"]} />

      <Group justify="space-between" align="center">
        <Group gap="xs">
          <Text size="xs" c="dimmed">
            {full.width} × {full.height} PNG
          </Text>
          {options.colormap === "random" && (
            <Tooltip label="Rolls a new random palette.">
              <ActionIcon size="sm" variant="subtle" color="gray" aria-label="New palette" onClick={reroll}>
                <Dices size={14} />
              </ActionIcon>
            </Tooltip>
          )}
        </Group>
        <Group gap="xs">
          <Button size="xs" variant="default" onClick={() => context.closeModal(id)}>
            Cancel
          </Button>
          <Button size="xs" loading={exporting} onClick={handleExport}>
            Export
          </Button>
        </Group>
      </Group>
    </Stack>
  );
};
