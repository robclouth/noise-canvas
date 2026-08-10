import { useStore } from "@renderer/store";
import { openFiles } from "@renderer/store/files";
import { DEFAULT_ONSET_SENSITIVITY } from "./constants";
import { getFilteredOnsets, type Onset } from "./onset-map";

/**
 * The onsets of an open file that pass that file's own sensitivity — the list
 * the markers, the time snap and the onset grid all work from, so all three
 * agree on which hits exist.
 */
export function getFileOnsets(fileId: string): Onset[] {
  const file = openFiles[fileId];
  if (!file?.onsets) return [];
  const sensitivity = useStore.getState().filepathsOnsetSensitivity[file.filePath] ?? DEFAULT_ONSET_SENSITIVITY;
  return getFilteredOnsets(fileId, file.onsets, sensitivity);
}
