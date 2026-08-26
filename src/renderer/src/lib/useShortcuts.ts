import { useEffect } from "react";
import { useStore } from "../store";
import { selectNumberKeyBrushIndices } from "../store/palettes";
import { useTransientStore } from "../store/transient";
import { acceleratorCommands, matchesAccelerator, runCommand } from "./app-menu";
import { host } from "./host";
import { digitFor, isUnmodifiedPress, letterFor, matchesChar, matchesCode, type KeyMatch } from "./keyboard";
import { cycleParameterMark, randomizeBrush } from "./shortcut-actions";

const isTextEntry = (t: HTMLElement | null): boolean => {
  if (!t) return false;
  if (t.tagName === "TEXTAREA") return true;
  if (t.isContentEditable) return true;
  if (t.getAttribute("role") === "textbox") return true;
  if (t.tagName === "INPUT") {
    const input = t as HTMLInputElement;
    if (["button", "checkbox", "radio", "submit", "reset", "file"].includes(input.type)) return false;
    if (input.readOnly) return false;
    return true;
  }
  return false;
};

export enum ShortcutAction {
  MoveBrushUp = "MoveBrushUp",
  MoveBrushDown = "MoveBrushDown",
  MoveBrushLeft = "MoveBrushLeft",
  MoveBrushRight = "MoveBrushRight",
  ApplyBrush = "ApplyBrush",
  IncreaseHorizontalGrid = "IncreaseHorizontalGrid",
  DecreaseHorizontalGrid = "DecreaseHorizontalGrid",
  IncreaseVerticalGrid = "IncreaseVerticalGrid",
  DecreaseVerticalGrid = "DecreaseVerticalGrid",
  IncreaseBrushSizeTime = "IncreaseBrushSizeTime",
  DecreaseBrushSizeTime = "DecreaseBrushSizeTime",
  IncreaseBrushSizePitch = "IncreaseBrushSizePitch",
  DecreaseBrushSizePitch = "DecreaseBrushSizePitch",
  ToggleSnapTime = "ToggleSnapTime",
  ToggleSnapPitch = "ToggleSnapPitch",
  RandomizeBrush = "RandomizeBrush",
  RandomizeBrushAndEffects = "RandomizeBrushAndEffects",
  ToggleLoop = "ToggleLoop",
  ToggleAutoPlayStroke = "ToggleAutoPlayStroke",
  ToggleEditMode = "ToggleEditMode",
  TogglePlayback = "TogglePlayback",
}

interface ShortcutDefinition extends KeyMatch {
  action: ShortcutAction;
}

export const SHORTCUTS: ShortcutDefinition[] = [
  { code: "ArrowUp", action: ShortcutAction.MoveBrushUp },
  { code: "ArrowDown", action: ShortcutAction.MoveBrushDown },
  { code: "ArrowLeft", action: ShortcutAction.MoveBrushLeft },
  { code: "ArrowRight", action: ShortcutAction.MoveBrushRight },
  { code: "Enter", action: ShortcutAction.ApplyBrush },
  { code: "NumpadEnter", action: ShortcutAction.ApplyBrush },
  { code: "Minus", chars: ["-"], action: ShortcutAction.DecreaseHorizontalGrid },
  { code: "NumpadSubtract", action: ShortcutAction.DecreaseHorizontalGrid },
  { code: "Equal", chars: ["="], action: ShortcutAction.IncreaseHorizontalGrid },
  { code: "NumpadAdd", action: ShortcutAction.IncreaseHorizontalGrid },
  { code: "Minus", shift: true, chars: ["_"], action: ShortcutAction.DecreaseVerticalGrid },
  { code: "Equal", shift: true, chars: ["+"], action: ShortcutAction.IncreaseVerticalGrid },
  { code: "BracketLeft", chars: ["["], action: ShortcutAction.DecreaseBrushSizeTime },
  { code: "BracketRight", chars: ["]"], action: ShortcutAction.IncreaseBrushSizeTime },
  { code: "BracketLeft", shift: true, chars: ["{"], action: ShortcutAction.DecreaseBrushSizePitch },
  { code: "BracketRight", shift: true, chars: ["}"], action: ShortcutAction.IncreaseBrushSizePitch },
  { code: "Semicolon", chars: [";"], action: ShortcutAction.ToggleSnapTime },
  { code: "Quote", chars: ["'"], action: ShortcutAction.ToggleSnapPitch },
  { code: "Backslash", chars: ["\\"], action: ShortcutAction.RandomizeBrush },
  { code: "Backslash", shift: true, chars: ["|"], action: ShortcutAction.RandomizeBrushAndEffects },
  { code: "Comma", chars: [","], action: ShortcutAction.ToggleLoop },
  { code: "Period", chars: ["."], action: ShortcutAction.ToggleAutoPlayStroke },
  { code: "Tab", action: ShortcutAction.ToggleEditMode },
  { code: "Space", chars: [" "], action: ShortcutAction.TogglePlayback },
];

/** Characters a shortcut owns, so a brush cannot be bound to one of them. */
export const RESERVED_KEYS = new Set(SHORTCUTS.flatMap((shortcut) => shortcut.chars ?? []));

/**
 * The shortcut a press runs. The character a layout prints wins over the key's
 * place on the board, so a layout that moved a character keeps the shortcut on
 * it and the key left behind still carries the one that lives at that place.
 */
export function resolveShortcut(event: KeyboardEvent): ShortcutDefinition | undefined {
  return (
    SHORTCUTS.find((shortcut) => matchesChar(event, shortcut)) ??
    SHORTCUTS.find((shortcut) => matchesCode(event, shortcut))
  );
}

/** The brush a press selects, by its bound letter or by its place in the top palette. */
function resolveBrushIndex(event: KeyboardEvent): number | undefined {
  if (!isUnmodifiedPress(event)) return undefined;
  const state = useStore.getState();

  if (!event.shiftKey) {
    const letter = letterFor(event);
    if (letter) {
      const index = state.brushes.findIndex((brush) => brush.hotkey === letter);
      return index >= 0 ? index : undefined;
    }
  }

  const digit = digitFor(event);
  if (digit === null) return undefined;
  return selectNumberKeyBrushIndices(state)[digit === 0 ? 9 : digit - 1];
}

export function useShortcuts() {
  const handleKeyDown = (event: KeyboardEvent) => {
    // Menu accelerators run wherever the focus is, as a native menu's would,
    // and are matched before anything that a text field would swallow.
    for (const { accelerator, command } of acceleratorCommands()) {
      if (!matchesAccelerator(event, accelerator)) continue;
      event.preventDefault();
      event.stopPropagation();
      runCommand(command);
      return;
    }

    // Only bail when the user is actually typing into a real text-entry element.
    // Focused buttons/selects/etc. must not swallow global shortcuts like Space.
    // Ahead of the modifier branches: Shift for a capital letter must not put
    // the canvas into source-pick mode.
    if (isTextEntry(event.target as HTMLElement)) return;

    // Escape belongs to whatever is on top: a dialog or the help overlay closes
    // first, and only a bare canvas clears its selection. This listener is on
    // the capture phase, so the event is left unconsumed either way.
    if (event.key === "Escape") {
      const state = useStore.getState();
      const dialogOpen = document.querySelector("[role='dialog']") !== null;
      if (dialogOpen || state.helpOverlayOpen) return;
      // A region in flight goes back to the clipboard before the selection is
      // given up, so one press never loses both.
      if (state.placing) state.cancelPlacing();
      else if (state.activeFileId) state.setFileSelection(state.activeFileId, null);
      return;
    }

    // Backspace and Delete wipe the selected region in place.
    if (event.key === "Backspace" || event.key === "Delete") {
      const state = useStore.getState();
      const selection = state.activeFileId ? state.filesSelection[state.activeFileId] : null;
      if (selection && !state.placing) {
        event.preventDefault();
        void state.silenceSelection();
        return;
      }
    }

    // Special handling for Shift (hold) - Pick source file position. Shift is
    // also the fine modifier on a parameter control, so a drag under way keeps
    // it off the canvas.
    if (event.key === "Shift") {
      // A region in flight owns Shift — it holds the region's pitch — so it
      // must not flip the canvas into source-pick mode under the ghost.
      const state = useStore.getState();
      if (!useTransientStore.getState().controlDragging && !state.placing) {
        state.setPickingFileParam("sourceFile" as import("@renderer/store/types").ParameterKey);
      }
      return;
    }

    // Platform-specific Zoom Modifier (Meta on Mac, Control on Windows/Linux)
    const isMac = host.env.platform === "darwin";
    const zoomKey = isMac ? "Meta" : "Control";

    if (event.key === zoomKey) {
      useStore.getState().setIsZooming(true);
      // Note: We don't return here because Meta/Control might be used for other shortcuts
      // (though we blocked them for "Set Source", usually they are modifiers for keys like "S", "Z", etc.)
      // However, standard Zoom logic (wheel) relies on this state.
    }

    const shortcut = resolveShortcut(event);

    if (shortcut) {
      event.preventDefault();
      event.stopPropagation();

      const state = useStore.getState();

      switch (shortcut.action) {
        case ShortcutAction.MoveBrushUp:
          state.moveBrushPosition("up");
          break;
        case ShortcutAction.MoveBrushDown:
          state.moveBrushPosition("down");
          break;
        case ShortcutAction.MoveBrushLeft:
          state.moveBrushPosition("left");
          break;
        case ShortcutAction.MoveBrushRight:
          state.moveBrushPosition("right");
          break;
        case ShortcutAction.ApplyBrush:
          state.applyBrushAtPosition();
          break;
        case ShortcutAction.IncreaseHorizontalGrid:
          cycleParameterMark("gridSizeBeats", 1);
          break;
        case ShortcutAction.DecreaseHorizontalGrid:
          cycleParameterMark("gridSizeBeats", -1);
          break;
        case ShortcutAction.IncreaseVerticalGrid:
          cycleParameterMark("gridSizeSemis", 1);
          break;
        case ShortcutAction.DecreaseVerticalGrid:
          cycleParameterMark("gridSizeSemis", -1);
          break;
        case ShortcutAction.IncreaseBrushSizeTime:
          cycleParameterMark("brushSizeTime", 1);
          break;
        case ShortcutAction.DecreaseBrushSizeTime:
          cycleParameterMark("brushSizeTime", -1);
          break;
        case ShortcutAction.IncreaseBrushSizePitch:
          cycleParameterMark("brushSizePitch", 1);
          break;
        case ShortcutAction.DecreaseBrushSizePitch:
          cycleParameterMark("brushSizePitch", -1);
          break;
        case ShortcutAction.ToggleSnapTime:
          state.setParameter("snapTime", !state.snapTime);
          break;
        case ShortcutAction.ToggleSnapPitch:
          state.setParameter("snapPitch", !state.snapPitch);
          break;
        case ShortcutAction.RandomizeBrush:
          randomizeBrush(false);
          break;
        case ShortcutAction.RandomizeBrushAndEffects:
          randomizeBrush(true);
          break;
        case ShortcutAction.ToggleLoop:
          state.setLoop(!state.loop);
          break;
        case ShortcutAction.ToggleAutoPlayStroke:
          state.setAutoPlayStroke(!state.autoPlayStroke);
          break;
        case ShortcutAction.ToggleEditMode:
          state.toggleEditMode();
          break;
        case ShortcutAction.TogglePlayback:
          state.togglePlayback();
          break;
      }
      return;
    }

    const brushIndex = resolveBrushIndex(event);
    if (brushIndex !== undefined) {
      event.preventDefault();
      useStore.getState().setActiveBrush(brushIndex);
    }
  };

  const handleKeyUp = (event: KeyboardEvent) => {
    if (event.key === "Shift") {
      useStore.getState().setPickingFileParam(null);
    }

    // Platform-specific Zoom Reset
    const isMac = host.env.platform === "darwin";
    const zoomKey = isMac ? "Meta" : "Control";
    if (event.key === zoomKey) {
      useStore.getState().setIsZooming(false);
    }
  };

  // Held modifiers drive these modes, and their keyup goes to whichever app the
  // user switched to. Without this the canvas comes back in pick or zoom mode.
  const clearHeldModifierModes = () => {
    const state = useStore.getState();
    state.setPickingFileParam(null);
    state.setIsZooming(false);
  };

  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.hidden) clearHeldModifierModes();
    };
    window.addEventListener("keydown", handleKeyDown, { capture: true });
    window.addEventListener("keyup", handleKeyUp, { capture: true });
    window.addEventListener("blur", clearHeldModifierModes);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      window.removeEventListener("keydown", handleKeyDown, { capture: true });
      window.removeEventListener("keyup", handleKeyUp, { capture: true });
      window.removeEventListener("blur", clearHeldModifierModes);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, []);
}
