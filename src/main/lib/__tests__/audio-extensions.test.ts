import { describe, expect, it } from "vitest";

import { allowedExtensions, hasSupportedAudioExtension } from "../audio-extensions";

/**
 * A plain launch passes the executable as the last argv entry, so the launch
 * path filter leans on this to tell a file argument from the app itself.
 */
describe("supported audio extensions", () => {
  it("accepts every format the analyser lists, in any case", () => {
    for (const ext of allowedExtensions) {
      expect(hasSupportedAudioExtension(`/music/take.${ext}`)).toBe(true);
      expect(hasSupportedAudioExtension(`/music/take.${ext.toUpperCase()}`)).toBe(true);
    }
  });

  it("rejects the app binary a plain launch passes", () => {
    expect(hasSupportedAudioExtension("/Applications/Noise Canvas.app/Contents/MacOS/Noise Canvas")).toBe(false);
    expect(hasSupportedAudioExtension("C:\\Program Files\\Noise Canvas\\Noise Canvas.exe")).toBe(false);
    expect(hasSupportedAudioExtension("/usr/local/bin/electron")).toBe(false);
  });

  it("rejects a dotted directory that leaves the file with no extension", () => {
    expect(hasSupportedAudioExtension("/Users/rob/my.wav.folder/README")).toBe(false);
  });

  it("rejects other formats and dotfiles", () => {
    expect(hasSupportedAudioExtension("/music/notes.txt")).toBe(false);
    expect(hasSupportedAudioExtension("/music/cover.png")).toBe(false);
    expect(hasSupportedAudioExtension("/music/.wav")).toBe(false);
    expect(hasSupportedAudioExtension("")).toBe(false);
  });

  it("reads the extension from the file name, not the path", () => {
    expect(hasSupportedAudioExtension("C:\\sounds\\kick.wav")).toBe(true);
    expect(hasSupportedAudioExtension("/sounds/kick.wav")).toBe(true);
  });
});
