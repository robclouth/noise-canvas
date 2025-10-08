import { BrushPanel } from "@/components/layout/brush-panel";
import { openFiles, useStore } from "@/store";
import { Group, ScrollArea, Stack } from "@mantine/core";
import { useWindowEvent } from "@mantine/hooks";
import { Notifications } from "@mantine/notifications";
import { View } from "@react-three/drei";
import { Canvas, RootState, useThree } from "@react-three/fiber";
import { useCallback, useEffect, useRef } from "react";
import { CanvasPanel } from "./components/layout/canvas-panel";
import { ControlsPanel } from "./components/layout/controls-panel";
import { TransportPanel } from "./components/layout/transport-panel";
import { UpdateNotification } from "./components/update-notification";
import { ipcOn, ipcSend } from "./lib/ipc";
import { getUndoManager } from "./lib/undo-manager";

type Invalidator = RootState["invalidate"];

const CanvasInvalidator = ({ onReady }: { onReady: (invalidate: Invalidator) => void }) => {
  const invalidate = useThree((s) => s.invalidate);
  useEffect(() => {
    onReady(invalidate);
  }, [invalidate, onReady]);
  return null;
};

function App(): React.JSX.Element {
  const invalidateRef = useRef<Invalidator | null>(null);

  useEffect(() => {
    const unsubscribers: (() => void)[] = [];

    // Development file loading
    if (process.env.NODE_ENV === "development") {
      const { openFilePath, openFileIds } = useStore.getState();
      if (openFileIds.length === 0) {
        // openFilePath(
        //   "/Users/rob/Splice/sounds/packs/Fresh Mint, a Rohaan moment/Moment_Rohaan_Fresh_Mint/loops/drum_loops/full_drum_loops/MO_RO_140_drum_loop_robust_shed.wav",
        // );
        openFilePath("/Users/rob/Desktop/up-tones.wav");
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

    // Update save menu state when active file's dirty state changes
    const unsubDirtyState = useStore.subscribe(
      (state) => {
        const activeFileId = state.activeFileId;
        return activeFileId ? state.filesDirty[activeFileId] || false : false;
      },
      (isDirty) => {
        ipcSend("update-save-state", isDirty);
      },
    );
    unsubscribers.push(unsubDirtyState);

    // IPC event listeners - type-safe direct communication
    const unsubOpenFile = ipcOn("open-file", async (_event, path) => {
      const { openFilePath } = useStore.getState();
      await openFilePath(path);
    });
    unsubscribers.push(unsubOpenFile);

    const unsubSaveActiveFile = ipcOn("save-active-file", () => {
      const { saveActiveFile } = useStore.getState();
      saveActiveFile();
    });
    unsubscribers.push(unsubSaveActiveFile);

    const unsubSaveActiveFileAs = ipcOn("save-active-file-as", () => {
      const { saveActiveFileAs } = useStore.getState();
      saveActiveFileAs();
    });
    unsubscribers.push(unsubSaveActiveFileAs);

    const unsubSaveActiveFileVersion = ipcOn("save-active-file-version", () => {
      const { saveActiveFileVersion } = useStore.getState();
      saveActiveFileVersion();
    });
    unsubscribers.push(unsubSaveActiveFileVersion);

    const unsubCloseActiveFile = ipcOn("close-active-file", () => {
      const { activeFileId, closeFile } = useStore.getState();
      if (activeFileId) {
        closeFile(activeFileId);
      }
    });
    unsubscribers.push(unsubCloseActiveFile);

    const unsubCloseAllFiles = ipcOn("close-all-files", () => {
      const { closeAllFiles } = useStore.getState();
      closeAllFiles();
    });
    unsubscribers.push(unsubCloseAllFiles);

    const unsubUndo = ipcOn("undo", async () => {
      const { activeFileId } = useStore.getState();
      if (!activeFileId) return;
      const undoManager = getUndoManager(activeFileId);
      await undoManager.undo();
    });
    unsubscribers.push(unsubUndo);

    const unsubRedo = ipcOn("redo", async () => {
      const { activeFileId } = useStore.getState();
      if (!activeFileId) return;
      const undoManager = getUndoManager(activeFileId);
      await undoManager.redo();
    });
    unsubscribers.push(unsubRedo);

    const unsubRestoreOriginal = ipcOn("restore-original", () => {
      const { activeFileId } = useStore.getState();
      if (!activeFileId) return;
      const file = openFiles[activeFileId];

      if (!file?.rendererRef?.current) return;

      file.rendererRef.current.restoreOriginal();
    });
    unsubscribers.push(unsubRestoreOriginal);

    const unsubReanalyzeActiveFile = ipcOn("reanalyze-active-file", () => {
      const { reanalyzeActiveFile } = useStore.getState();
      reanalyzeActiveFile();
    });
    unsubscribers.push(unsubReanalyzeActiveFile);

    return () => {
      unsubscribers.forEach((unsub) => unsub());
      const { closeAllFiles } = useStore.getState();
      closeAllFiles();
    };
  }, []);

  // Invalidate canvas when layout changes (sections collapse/expand)
  const sectionCollapsed = useStore((state) => state.sectionCollapsed);
  const effectsEnabled = useStore((state) => state.effectsEnabled);

  useEffect(() => {
    // Invalidate multiple times during the animation for smooth updates
    const invalidate = () => invalidateRef.current?.();

    invalidate(); // Immediate
    requestAnimationFrame(() => {
      invalidate();
      requestAnimationFrame(invalidate);
    });

    // Continue invalidating every frame during the animation
    const startTime = Date.now();
    const animationDuration = 200; // Mantine Collapse default

    const intervalId = setInterval(() => {
      if (Date.now() - startTime > animationDuration) {
        clearInterval(intervalId);
      }
      invalidate();
    }, 16); // ~60fps

    return () => clearInterval(intervalId);
  }, [sectionCollapsed, effectsEnabled]);

  const handleKeyDown = useCallback((event: KeyboardEvent) => {
    if (
      event.code === "Space" &&
      !(event.target instanceof HTMLInputElement) &&
      !(event.target instanceof HTMLTextAreaElement)
    ) {
      event.preventDefault();
      useStore.getState().togglePlayback();
    }

    // Toggle set position mode with Control key
    if (event.key === "Control") {
      useStore.getState().setIsSettingPosition(true);
    }
  }, []);

  const handleKeyUp = useCallback((event: KeyboardEvent) => {
    // Turn off set position mode when Control is released
    if (event.key === "Control") {
      useStore.getState().setIsSettingPosition(false);
    }
  }, []);

  useWindowEvent("keydown", handleKeyDown);
  useWindowEvent("keyup", handleKeyUp);

  return (
    <Group h="100vh" w="100vw" wrap="nowrap" gap={0}>
      <Canvas
        style={{ position: "absolute", top: 0, left: 0, width: "100%", height: "100%" }}
        eventSource={document.getElementById("root")!}
        frameloop="demand"
      >
        <View.Port />
        <CanvasInvalidator onReady={(invalidate) => (invalidateRef.current = invalidate)} />
      </Canvas>
      <ScrollArea w={300} miw={300} h="100%" onScrollPositionChange={() => invalidateRef.current?.()}>
        <BrushPanel />
      </ScrollArea>
      <Stack flex={1} h="100%" gap={0}>
        <ScrollArea flex={1} w="100%" onScrollPositionChange={() => invalidateRef.current?.()}>
          <CanvasPanel />
        </ScrollArea>
        <TransportPanel />
      </Stack>
      <ScrollArea w={300} miw={300} h="100%" onScrollPositionChange={() => invalidateRef.current?.()}>
        <ControlsPanel />
      </ScrollArea>
      <Notifications />
      <UpdateNotification />
    </Group>
  );
}

export default App;
