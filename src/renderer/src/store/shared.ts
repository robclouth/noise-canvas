import * as Tone from "tone";
import type { OpenFile } from "./types";

// Open files keyed by file ID
export const openFiles: Record<string, OpenFile> = {};

// Tone.js player for audio playback
export const player = new Tone.Player().toDestination();

// Helper to get file by ID
export function getFileById(fileId: string): OpenFile | undefined {
  return openFiles[fileId];
}

// Helper to find file ID by path
export function getFileIdByPath(filePath: string): string | undefined {
  return Object.keys(openFiles).find((id) => openFiles[id].filePath === filePath);
}
