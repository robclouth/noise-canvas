import type { Brush } from "@renderer/store/types";

/**
 * Resolves a pattern token to a brush index, mirroring how the sidebar names
 * brushes: a digit is a slot number, a letter is an assigned hotkey, a word is
 * a brush name. Returns null when nothing matches, which leaves the caller on
 * the active brush — the rule that lets factory presets run on any palette.
 */
export function resolveBrushToken(token: string, brushes: Brush[]): number | null {
  const trimmed = token.trim();
  if (trimmed === "") return null;

  if (/^[0-9]$/.test(trimmed)) {
    // Slots read left to right as 1–9 then 0, matching the digit shortcuts.
    const index = trimmed === "0" ? 9 : Number(trimmed) - 1;
    return index < brushes.length ? index : null;
  }

  const lower = trimmed.toLowerCase();

  const byHotkey = brushes.findIndex((brush) => brush.hotkey != null && brush.hotkey.toLowerCase() === lower);
  if (byHotkey >= 0) return byHotkey;

  const byName = brushes.findIndex((brush) => brush.name.toLowerCase() === lower);
  if (byName >= 0) return byName;

  return null;
}
