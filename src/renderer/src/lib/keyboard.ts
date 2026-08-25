/**
 * Key matching that survives a change of keyboard layout. A press is read first
 * as the character the layout prints on it, and failing that as the key's place
 * on the board, so a shortcut answers to the character wherever a layout moved
 * it and still sits in the same place when the layout prints something else.
 */

/** A key a shortcut answers to. */
export interface KeyMatch {
  /** The key's place on the board, as `KeyboardEvent.code`. */
  code: string;
  /** Shift state the place-on-the-board match needs. */
  shift?: boolean;
  /** Characters that trigger it wherever a layout prints them. */
  chars?: string[];
}

/** True when the press carries no modifier a shortcut has to stay clear of. AltGr prints characters, so it passes. */
export function isPlainCharPress(event: KeyboardEvent): boolean {
  if (event.metaKey) return false;
  if (event.getModifierState?.("AltGraph")) return true;
  return !event.ctrlKey && !event.altKey;
}

/** True when the press carries no modifier at all beyond Shift. */
export function isUnmodifiedPress(event: KeyboardEvent): boolean {
  return !event.metaKey && !event.ctrlKey && !event.altKey;
}

/**
 * True when the press prints one of the match's characters. Shift is left out:
 * a layout decides for itself which of its characters need it. Numpad keys are
 * matched by place only, so their `+` and `-` stay separate from the shifted
 * characters of the main rows.
 */
export function matchesChar(event: KeyboardEvent, match: KeyMatch): boolean {
  if (event.code.startsWith("Numpad")) return false;
  if (!isPlainCharPress(event)) return false;
  return match.chars?.includes(event.key) ?? false;
}

/** True when the press is the key at the match's place on the board. */
export function matchesCode(event: KeyboardEvent, match: KeyMatch): boolean {
  if (!isUnmodifiedPress(event)) return false;
  return event.code === match.code && event.shiftKey === Boolean(match.shift);
}

/** The letter a press stands for: the one it prints, else the one at its place on a US board. */
export function letterFor(event: KeyboardEvent): string | null {
  if (/^[a-zA-Z]$/.test(event.key)) return event.key.toLowerCase();
  if (/^Key[A-Z]$/.test(event.code)) return event.code.slice(3).toLowerCase();
  return null;
}

/** The digit a press stands for. A layout whose digit row needs Shift still gives digits. */
export function digitFor(event: KeyboardEvent): number | null {
  if (/^[0-9]$/.test(event.key)) return Number(event.key);
  if (!event.shiftKey && /^Digit[0-9]$/.test(event.code)) return Number(event.code.slice(5));
  return null;
}
