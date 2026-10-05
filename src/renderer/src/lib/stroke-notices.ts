import { notifications, type NotificationData } from "@mantine/notifications";

/** Why a file takes no strokes after the canvas failed to drop one. */
export const STROKE_LOCKED =
  "The last stroke could not be taken off the canvas. Close and reopen the file before painting again.";

/** Why a dab that should paint did not, when no setting of the brush explains it. */
export const DAB_NOT_TAKEN = "The canvas could not take that part of the stroke. Paint it again.";

/** Why a file still opening takes no strokes. */
export const FILE_OPENING = "This file is still opening. Paint again once it has opened.";

/** Shows `notice` in place of any open notice with its id, so the latest reason is the one on screen. */
function replaceNotice(notice: NotificationData & { id: string }): void {
  notifications.hide(notice.id);
  notifications.show(notice);
}

/** Shows that a stroke painted nothing, and why. */
export function showNothingPainted(reason: string): void {
  replaceNotice({ id: "nothing-painted", color: "yellow", title: "Nothing painted", message: reason });
}

/** Shows that part of a stroke on `fileId` did not paint, and why. */
export function showPartlyPainted(fileId: string, reason: string): void {
  replaceNotice({
    id: `partly-painted-${fileId}`,
    color: "yellow",
    title: "Part of the stroke not painted",
    message: reason,
  });
}

/** Shows that `skipped` of `total` pieces of an edit named `label` did not paint, and why. */
export function showPiecesSkipped(label: string, skipped: number, total: number, unit: string, reason: string): void {
  if (skipped >= total) {
    replaceNotice({ id: "pieces-skipped", color: "yellow", title: `${label}: nothing painted`, message: reason });
    return;
  }
  replaceNotice({
    id: "pieces-skipped",
    color: "yellow",
    title: `${label}: ${skipped} of ${total} ${unit} not painted`,
    message: reason,
  });
}

/** Shows why a magic wand selection stopped short of the whole patch. */
export function showWandStop(why: "size" | "read"): void {
  notifications.show({
    id: "wand-stopped",
    color: "yellow",
    title: why === "size" ? "Selection stopped growing" : "Nothing selected",
    message:
      why === "size"
        ? "The wand reached its size limit, so the selection holds only part of the patch. Drag down to tighten it, or select with the rectangle."
        : "Part of the file could not be read for the wand. Click again.",
  });
}
