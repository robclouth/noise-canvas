import type { OpenRawSettings } from "../store/open-raw";
import { RAW_MAX_SECONDS, RAW_RATE, rawFrameBytes, rawOutputFrames, type RawOpenOptions } from "./raw-file";

/** The open options the settings describe for a file of `fileSize` bytes. */
export function rawOpenOptions(settings: OpenRawSettings, fileSize: number): RawOpenOptions {
  const frameBytes = rawFrameBytes(settings.rawFormat, settings.rawStereo);
  const most = Math.floor(RAW_MAX_SECONDS * RAW_RATE * settings.rawSpeed) * frameBytes;
  const bytes = Math.max(0, Math.round(settings.rawBytes));
  return {
    length: Math.min(fileSize, bytes > 0 ? bytes : most),
    format: settings.rawFormat,
    stereo: settings.rawStereo,
    read: settings.rawRead,
    holdLength: Math.max(1, Math.round(settings.rawHoldLength)),
    speed: settings.rawSpeed,
    removeNoise: Math.max(0, Math.min(1, settings.rawRemoveNoise / 100)),
  };
}

/** How long the result runs, or why the settings cannot open. */
export function rawDialogOutcome(
  settings: OpenRawSettings,
  fileSize: number,
): { seconds: number } | { problem: string } {
  const seconds = rawOutputFrames(rawOpenOptions(settings, fileSize)) / RAW_RATE;
  if (seconds <= 0) return { problem: "These bytes make no sound. Set Bytes higher." };
  if (seconds > RAW_MAX_SECONDS + 1e-9) {
    return { problem: `That runs past ${RAW_MAX_SECONDS / 60} minutes. Set Bytes lower or Speed higher.` };
  }
  return { seconds };
}

/** A length as m:ss.s, or in milliseconds under a second. */
export function formatRawDuration(seconds: number): string {
  if (seconds < 1) return `${Math.max(1, Math.round(seconds * 1000))} ms`;
  const whole = Math.round(seconds * 10) / 10;
  const minutes = Math.floor(whole / 60);
  return `${minutes}:${(whole - minutes * 60).toFixed(1).padStart(4, "0")}`;
}
