import { notifications } from "@mantine/notifications";
import { getUndoManager } from "./lib/undo-manager";
import { openFiles, useStore } from "./store";

let unsubscribers: (() => void)[] = [];

export async function init() {
  if (process.env.NODE_ENV === "development") {
    const { openFilePath, openFilePaths } = useStore.getState();
    if (openFilePaths.length === 0) {
      await openFilePath(
        "/Users/rob/Splice/sounds/packs/Fresh Mint, a Rohaan moment/Moment_Rohaan_Fresh_Mint/loops/drum_loops/full_drum_loops/MO_RO_140_drum_loop_robust_shed.wav",
      );
      // await openFilePath(
      //   "/Users/rob/Splice/sounds/packs/Indian Vocal Pack (Mitika Kanwar)/Indian_Vocal_Pack/Loops/Resampled/JMK_IVP_124_indian_vocal_female_hook_humming_dance_resampled_pitched_A#m.wav",
      // );
      // openFile("/Users/rob/Desktop/test.wav").catch((error) => {
      //   console.error("Failed to open test file:", error);
      // });
      // openFile("/Users/rob/Desktop/tone2.wav");
      // openFile("/Users/rob/Desktop/tone2-sat.wav");
    }
  }

  // Clear locked offset when switching away from offset mode
  const unsubModeChange = useStore.subscribe(
    (state) => state.sourcePositionMode.value,
    (mode, prevMode) => {
      if (prevMode === "offset" && mode !== "offset") {
        useStore.getState().setLockedOffset(null);
      }
    },
  );
  unsubscribers.push(unsubModeChange);

  const unsubOpenFile = window.api.onOpenFile(async (path) => {
    const { openFilePath } = useStore.getState();

    await openFilePath(path);
  });
  unsubscribers.push(unsubOpenFile);

  const unsubCloseActiveFile = window.api.onCloseActiveFile(() => {
    const { activeFilePath, closeFilePath: closeFile } = useStore.getState();
    if (activeFilePath) {
      closeFile(activeFilePath);
    }
  });
  unsubscribers.push(unsubCloseActiveFile);

  const unsubCloseAllFiles = window.api.onCloseAllFiles(() => {
    const { closeAllFilePaths } = useStore.getState();
    closeAllFilePaths();
  });
  unsubscribers.push(unsubCloseAllFiles);

  // Handle undo/redo directly in renderer (no IPC)
  const unsubUndo = window.api.onUndo(async () => {
    const { activeFilePath } = useStore.getState();
    if (!activeFilePath) return;
    const undoManager = getUndoManager(activeFilePath);
    await undoManager.undo();
  });
  unsubscribers.push(unsubUndo);

  const unsubRedo = window.api.onRedo(async () => {
    const { activeFilePath } = useStore.getState();
    if (!activeFilePath) return;
    const undoManager = getUndoManager(activeFilePath);
    await undoManager.redo();
  });
  unsubscribers.push(unsubRedo);

  const unsubRequestAudioForSaving = window.api.onRequestAudioForSaving(async () => {
    const { activeFilePath, normalize } = useStore.getState();
    const activeFile = activeFilePath ? openFiles[activeFilePath] : null;

    if (!activeFile) return;
    const rendererRef = activeFile.rendererRef;
    if (!rendererRef?.current) return;

    const processedData = await rendererRef.current.getFBOData();
    const spectrogramData = activeFile.spectrogramData;
    if (!processedData || !spectrogramData) {
      return;
    }

    const analysisParams = {
      bandsPerOctave: activeFile.spectrogramData.bandsPerOctave,
      minFreq: activeFile.spectrogramData.minFreq,
    };

    try {
      // Use direct gaborator synthesis (no IPC transfer)
      if (!window.gaborator) {
        throw new Error("Direct gaborator API not available");
      }

      const audioChannels = await window.gaborator.synthesize(
        processedData,
        {
          numFrames: spectrogramData.numFrames,
          numChannels: spectrogramData.numChannels,
          numBands: spectrogramData.numBands,
          ...spectrogramData.synthesisMetadata,
        },
        spectrogramData.sampleRate,
        analysisParams,
        normalize.value,
      );

      // Send synthesized audio to main process for ffmpeg encoding
      await window.api.saveAudioData(audioChannels);

      notifications.show({
        title: "Success",
        message: "File saved successfully!",
        color: "green",
      });
      console.log("File saved successfully!");
    } catch (e) {
      console.error("Failed to save audio", e);
      notifications.show({
        title: "Failed to save file",
        message: e instanceof Error ? e.message : "An unknown error occurred.",
        color: "red",
      });
    }
  });
  unsubscribers.push(unsubRequestAudioForSaving);

  const unsubRestore = window.api.onRestoreOriginal(() => {
    const { activeFilePath } = useStore.getState();
    if (!activeFilePath) return;
    const file = openFiles[activeFilePath]; // Get the ref from the map

    if (!file?.rendererRef?.current) return;

    file.rendererRef.current.restoreOriginal();
  });
  unsubscribers.push(unsubRestore);

  const unsubReanalyze = window.api.onReanalyzeActiveFile(() => {
    const { reanalyzeActiveFile } = useStore.getState();
    reanalyzeActiveFile();
  });
  unsubscribers.push(unsubReanalyze);

  // Subscribe to active file changes to notify the main process and update menu
  useStore.subscribe((state, prevState) => {
    if (state.activeFilePath !== prevState.activeFilePath) {
      const newPath = state.activeFilePath;
      if (newPath) {
        window.api.setActiveFile(newPath);
        // Update menu state for the new active file
        updateMenuState(newPath);
      } else {
        // No active file - disable undo/redo
        window.api.updateMenuState(false, false);
      }
    }
  });
}

// Helper function to update menu state based on current undo manager
function updateMenuState(filePath: string | null) {
  if (!filePath) {
    window.api.updateMenuState(false, false);
    return;
  }

  const undoManager = getUndoManager(filePath);
  const canUndo = undoManager.canUndo();
  const canRedo = undoManager.canRedo();
  window.api.updateMenuState(canUndo, canRedo);
}

export function destroy() {
  unsubscribers.forEach((unsub) => unsub());
  unsubscribers = [];
  const { closeAllFilePaths } = useStore.getState();
  closeAllFilePaths();
}
