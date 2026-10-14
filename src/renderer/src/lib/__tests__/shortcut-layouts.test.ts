import { describe, expect, it, vi } from "vitest";

vi.mock("../host", () => ({ host: { env: { platform: "darwin", isExtension: false } } }));

import { acceleratorCommands, matchesAccelerator } from "../app-menu";
import { digitFor, letterFor } from "../keyboard";
import { resolveShortcut, ShortcutAction } from "../useShortcuts";

/**
 * A press as a layout reports it: the character it printed, and the key's place
 * on the board. The two disagree on every layout that is not US QWERTY.
 */
function press(init: Partial<KeyboardEventInit> & { key: string; code: string }): KeyboardEvent {
  return new KeyboardEvent("keydown", init);
}

const actionOf = (event: KeyboardEvent) => resolveShortcut(event)?.action;

describe("shortcuts on a US layout", () => {
  it("cycles the time grid on the unshifted keys", () => {
    expect(actionOf(press({ key: "-", code: "Minus" }))).toBe(ShortcutAction.DecreaseHorizontalGrid);
    expect(actionOf(press({ key: "=", code: "Equal" }))).toBe(ShortcutAction.IncreaseHorizontalGrid);
  });

  it("cycles the pitch grid on the shifted keys, which print _ and +", () => {
    expect(actionOf(press({ key: "_", code: "Minus", shiftKey: true }))).toBe(ShortcutAction.DecreaseVerticalGrid);
    expect(actionOf(press({ key: "+", code: "Equal", shiftKey: true }))).toBe(ShortcutAction.IncreaseVerticalGrid);
  });

  it("keeps the numpad on the time grid, though it prints + unshifted", () => {
    expect(actionOf(press({ key: "+", code: "NumpadAdd" }))).toBe(ShortcutAction.IncreaseHorizontalGrid);
    expect(actionOf(press({ key: "-", code: "NumpadSubtract" }))).toBe(ShortcutAction.DecreaseHorizontalGrid);
  });

  it("sizes the brush on the bracket keys", () => {
    expect(actionOf(press({ key: "[", code: "BracketLeft" }))).toBe(ShortcutAction.DecreaseBrushSizeTime);
    expect(actionOf(press({ key: "}", code: "BracketRight", shiftKey: true }))).toBe(
      ShortcutAction.IncreaseBrushSizePitch,
    );
  });

  it("leaves a key alone once a menu modifier is on it", () => {
    expect(actionOf(press({ key: "-", code: "Minus", metaKey: true }))).toBeUndefined();
    expect(actionOf(press({ key: "\\", code: "Backslash", ctrlKey: true }))).toBeUndefined();
  });
});

describe("shortcuts on other layouts", () => {
  // AZERTY prints - on the key at the place of 6, and reaches the digits with Shift.
  it("follows the character to whichever key prints it", () => {
    expect(actionOf(press({ key: "-", code: "Digit6" }))).toBe(ShortcutAction.DecreaseHorizontalGrid);
    expect(actionOf(press({ key: ",", code: "KeyM" }))).toBe(ShortcutAction.ToggleLoop);
  });

  it("still reads a shifted digit row as digits", () => {
    expect(digitFor(press({ key: "6", code: "Digit6", shiftKey: true }))).toBe(6);
    expect(digitFor(press({ key: "1", code: "Digit1" }))).toBe(1);
  });

  // German QWERTZ prints [ on AltGr+8, which Windows reports as Ctrl and Alt.
  it("takes a character typed with AltGr", () => {
    const altGr = press({ key: "[", code: "Digit8", ctrlKey: true, altKey: true, modifierAltGraph: true });
    expect(actionOf(altGr)).toBe(ShortcutAction.DecreaseBrushSizeTime);
  });

  // A layout with no Latin letters leaves only the key's place to go on.
  it("falls back to the letter at the key's place", () => {
    expect(letterFor(press({ key: "ы", code: "KeyS" }))).toBe("s");
    expect(letterFor(press({ key: "s", code: "KeyO" }))).toBe("s");
  });
});

describe("menu accelerators on other layouts", () => {
  const undo = { code: "KeyZ" };
  const closeFile = { code: "KeyW" };

  // AZERTY swaps the two: the key at the place of W prints z, and the reverse.
  it("follows the letter the layout prints, not the key's place", () => {
    const pressedZ = press({ key: "z", code: "KeyW", metaKey: true });
    expect(matchesAccelerator(pressedZ, undo)).toBe(true);
    expect(matchesAccelerator(pressedZ, closeFile)).toBe(false);
  });

  it("falls back to the key's place where the layout prints no Latin letter", () => {
    const pressedCyrillic = press({ key: "я", code: "KeyZ", metaKey: true });
    expect(matchesAccelerator(pressedCyrillic, undo)).toBe(true);
  });

  it("finds punctuation wherever a layout hides it", () => {
    const slashOnAzerty = press({ key: "/", code: "Period", shiftKey: true, metaKey: true });
    expect(matchesAccelerator(slashOnAzerty, { code: "Slash" })).toBe(true);
  });

  it("holds Shift apart, so redo is not undo", () => {
    const shifted = press({ key: "Z", code: "KeyZ", shiftKey: true, metaKey: true });
    expect(matchesAccelerator(shifted, undo)).toBe(false);
    expect(matchesAccelerator(shifted, { code: "KeyZ", shift: true })).toBe(true);
  });
});

describe("the menus' own accelerators", () => {
  /** How an accelerator is written as a comparable key, e.g. "shift+KeyG". */
  const spell = (accelerator: { code: string; shift?: boolean; alt?: boolean }) =>
    `${accelerator.alt ? "alt+" : ""}${accelerator.shift ? "shift+" : ""}${accelerator.code}`;

  it("gives no two commands the same one", () => {
    const seen = new Map<string, string>();
    const clashes: string[] = [];
    for (const { accelerator, command } of acceleratorCommands()) {
      const key = spell(accelerator);
      const taken = seen.get(key);
      if (taken && taken !== command) clashes.push(`${key}: ${taken} and ${command}`);
      else seen.set(key, command);
    }
    expect(clashes).toEqual([]);
  });

  it("puts grouping on G and fill grid out of its way", () => {
    const commandFor = (key: string) =>
      acceleratorCommands().find(({ accelerator }) => spell(accelerator) === key)?.command;

    expect(commandFor("KeyG")).toBe("add-files-as-layers");
    expect(commandFor("shift+KeyG")).toBe("copy-layers-to-files");
    expect(commandFor("KeyF")).toBe("fill-grid");
  });

  it("puts inverting on I and insert silence out of its way", () => {
    const commandFor = (key: string) =>
      acceleratorCommands().find(({ accelerator }) => spell(accelerator) === key)?.command;

    expect(commandFor("KeyI")).toBe("invert-selection");
    expect(commandFor("shift+KeyI")).toBe("insert-silence");
  });
});
