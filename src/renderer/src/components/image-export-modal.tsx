import { Box, Button, Group, Loader, SegmentedControl, Stack, Switch, Text } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import type { ContextModalProps } from "@mantine/modals";
import { COLORMAPS, rerollRandomColormap } from "@renderer/lib/image-export-colormaps";
import {
  ASPECTS,
  canvasToPngBytes,
  computeImageSize,
  DEFAULT_EXPORT_OPTIONS,
  SIZE_OPTIONS,
  type AspectId,
  type ImageExportOptions,
} from "@renderer/lib/image-export";
import type { PosterInfo } from "@renderer/lib/image-export-poster";
import type { ColormapId } from "@renderer/lib/image-export-colormaps";
import { host } from "@renderer/lib/host";
import { openContextModal } from "@renderer/lib/modals";
import { openFiles } from "@renderer/store/files";
import { isManagedFilePath } from "@renderer/store/utils";
import { useCallback, useEffect, useRef, useState } from "react";

/** Long edge of the preview render. Covers a retina preview box without lag. */
const PREVIEW_LONG_EDGE = 960;
const PREVIEW_DEBOUNCE_MS = 120;

// Last-used settings, so reopening the dialog picks up where it left off.
let lastOptions: ImageExportOptions = DEFAULT_EXPORT_OPTIONS;

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
  const [options, setOptions] = useState<ImageExportOptions>(lastOptions);
  const [rendering, setRendering] = useState(true);
  const [exporting, setExporting] = useState(false);
  // Bumped on every click of the Random swatch, including when it is already
  // selected, so each click redraws the preview with a new ramp.
  const [paletteVersion, setPaletteVersion] = useState(0);
  const previewRef = useRef<HTMLDivElement>(null);

  const update = useCallback((patch: Partial<ImageExportOptions>) => {
    setOptions((prev) => {
      const next = { ...prev, ...patch };
      lastOptions = next;
      return next;
    });
  }, []);

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

      <Stack gap={6}>
        <Text size="xs" c="dimmed">
          Colour
        </Text>
        <SegmentedControl
          size="xs"
          fullWidth
          value={options.colormap}
          onChange={(value) => update({ colormap: value as ColormapId })}
          onClick={(event) => {
            // Mantine only fires onChange when the value actually changes, so
            // re-picking Random has to be caught from the click itself. The
            // radio sits beside its label rather than inside it, so the label's
            // own `control` link is what identifies which segment was hit.
            const label = (event.target as HTMLElement).closest("label");
            const control = label instanceof HTMLLabelElement ? label.control : null;
            if (!(control instanceof HTMLInputElement) || control.value !== "random") return;
            rerollRandomColormap();
            setPaletteVersion((version) => version + 1);
          }}
          data={COLORMAPS.map((c) => ({ value: c.id, label: c.label }))}
        />
      </Stack>

      <Stack gap={6}>
        <Text size="xs" c="dimmed">
          Shape
        </Text>
        <SegmentedControl
          size="xs"
          fullWidth
          value={options.aspect}
          onChange={(value) => update({ aspect: value as AspectId })}
          data={ASPECTS.map((a) => ({ value: a.id, label: a.short }))}
        />
      </Stack>

      <Group justify="space-between" align="center" wrap="nowrap">
        <Stack gap={6} style={{ flex: 1 }}>
          <Text size="xs" c="dimmed">
            Size
          </Text>
          <SegmentedControl
            size="xs"
            value={String(options.size)}
            onChange={(value) => update({ size: Number(value) })}
            data={SIZE_OPTIONS.map((s) => ({ value: String(s.value), label: s.label }))}
          />
        </Stack>
        <Switch
          size="xs"
          labelPosition="left"
          label="Poster"
          checked={options.poster}
          onChange={(event) => update({ poster: event.currentTarget.checked })}
        />
      </Group>

      <Group justify="space-between" align="center">
        <Text size="xs" c="dimmed">
          {full.width} × {full.height} PNG
        </Text>
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
