import { BrushPanel } from "@/components/layout/brush-panel";
import { useStore } from "@/store";
import { Box, Group, LoadingOverlay, ScrollArea, Stack } from "@mantine/core";
import { Notifications } from "@mantine/notifications";
import { View } from "@react-three/drei";
import { Canvas, RootState, useThree } from "@react-three/fiber";
import { useCallback, useEffect, useRef, useState } from "react";
import { useDropzone } from "react-dropzone";
import { EmptyState } from "./components/empty-state";
import { CanvasPanel } from "./components/layout/canvas-panel";
import { ControlsPanel } from "./components/layout/controls-panel";
import { TransportPanel } from "./components/layout/transport-panel";
import { UpdateNotification } from "./components/update-notification";
import { ipcOn, ipcSend } from "./lib/ipc";
import { precompileAllShaders } from "./lib/precompile-shaders";
import { clearAllUndoManagers, getUndoManager } from "./lib/undo-manager";
import { useLinkSync } from "./lib/use-link-sync";
import { useShortcuts } from "./lib/useShortcuts";
import { openFiles } from "./store/files";

type Invalidator = RootState["invalidate"];

const CanvasInvalidator = ({ onReady }: { onReady: (invalidate: Invalidator) => void }) => {
  const invalidate = useThree((s) => s.invalidate);
  useEffect(() => {
    onReady(invalidate);
  }, [invalidate, onReady]);
  return null;
};

const ShaderCompiler = ({ onFinish }: { onFinish: () => void }) => {
  const gl = useThree((s) => s.gl);
  useEffect(() => {
    try {
      precompileAllShaders(gl);
    } catch (err) {
      console.error("Shader pre-compilation failed:", err);
    }
    onFinish();
  }, [gl, onFinish]);
  return null;
};

function App(): React.JSX.Element {
  useShortcuts();
  useLinkSync();
  const [isReady, setIsReady] = useState(false);
  const openFileIds = useStore((state) => state.openFileIds);
  const fullscreenFileId = useStore((state) => state.fullscreenFileId);

  const invalidateRef = useRef<Invalidator | null>(null);

  useEffect(() => {
    invalidateRef.current?.();
  }, [fullscreenFileId]);

  useEffect(() => {
    const unsubscribers: (() => void)[] = [];

    // Development file loading
    if (process.env.NODE_ENV === "development") {
      const { openFilePath, openFileIds } = useStore.getState();
      if (openFileIds.length === 0) {
        openFilePath(
          "/Users/rob/Splice/sounds/packs/Fresh Mint, a Rohaan moment/Moment_Rohaan_Fresh_Mint/loops/drum_loops/full_drum_loops/MO_RO_140_drum_loop_robust_shed.wav",
        );
        openFilePath(
          "/Users/rob/Splice/sounds/packs/lofi crates./Origin_Sound__-_lofi_crates/loops/vocals_loops/OS_LFC_80_vocal_backing_honey_A#m.wav",
        );
        // openFilePath("/Users/rob/Documents/Projects/Music/Samples/local women singing at the clinic.mp3");
        // openFilePath(
        //   "/Users/rob/Splice/sounds/packs/The Jungle Drummer - Breakbeat Culture/Test_Press_-_The_Jungle_Drummer_-_Breakbeat_Culture/Loops/Layered_Breaks/TSP_TJD_172_break_layered_2snare_junglism.wav",
        // );
        // openFilePath(process.cwd() + "/test-audio/tone-440hz-5s.wav");
      }
    }

    // Clear locked offset when switching away from offset mode
    const unsubModeChange = useStore.subscribe(
      (state) => state.sourcePositionMode,
      (mode, prevMode) => {
        if (prevMode === "offset" && mode !== "offset") {
          useStore.getState().setLockedOffset(null);
        }
      },
    );
    unsubscribers.push(unsubModeChange);

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

    const unsubNewFile = ipcOn("new-file", async () => {
      const { newFile } = useStore.getState();
      await newFile();
    });
    unsubscribers.push(unsubNewFile);

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

    const unsubDuplicateActiveFile = ipcOn("duplicate-active-file", () => {
      const { activeFileId, duplicateFile } = useStore.getState();
      if (activeFileId) {
        duplicateFile(activeFileId);
      }
    });
    unsubscribers.push(unsubDuplicateActiveFile);

    const unsubCloseActiveFile = ipcOn("close-active-file", () => {
      const { activeFileId, tryCloseFile } = useStore.getState();
      if (activeFileId) {
        tryCloseFile(activeFileId);
      }
    });
    unsubscribers.push(unsubCloseActiveFile);

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

    const unsubAppWillQuit = ipcOn("app-will-quit", async () => {
      await clearAllUndoManagers();
    });
    unsubscribers.push(unsubAppWillQuit);

    return () => {
      unsubscribers.forEach((unsub) => unsub());
    };
  }, []);

  const onDrop = useCallback((acceptedFiles: File[]) => {
    if (acceptedFiles.length === 0) {
      return;
    }
    const filePath = window.electron.webUtils.getPathForFile(acceptedFiles[0]);
    useStore.getState().openFilePath(filePath);
  }, []);

  const handleShaderCompileFinish = useCallback(() => {
    setIsReady(true);
  }, []);

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    getFilesFromEvent: async (event) => {
      return Array.from((event as any).dataTransfer.files);
    },
    multiple: false,
    accept: { "audio/*": [] },
    noClick: true,
    noKeyboard: true,
  });

  return (
    <Group h="100vh" w="100vw" wrap="nowrap" gap={0} {...getRootProps()}>
      <LoadingOverlay visible={!isReady} />
      {isDragActive && (
        <Box
          pos="absolute"
          top={0}
          left={0}
          right={0}
          bottom={0}
          bg="transparent"
          bd="2px solid orange"
          style={{ zIndex: 10000 }}
        />
      )}
      <input {...getInputProps()} />
      <Canvas
        dpr={1}
        style={{ position: "absolute", top: 0, left: 0, width: "100%", height: "100%" }}
        eventSource={document.getElementById("root")!}
        frameloop="demand"
        gl={{
          antialias: false,
          depth: false,
          premultipliedAlpha: false,
          preserveDrawingBuffer: false,
          powerPreference: "high-performance",
        }}
      >
        <View.Port />
        <CanvasInvalidator onReady={(invalidate) => (invalidateRef.current = invalidate)} />

        <ShaderCompiler onFinish={handleShaderCompileFinish} />
      </Canvas>
      <ScrollArea
        scrollbarSize={4}
        type="auto"
        h="100%"
        w={320}
        onScrollPositionChange={() => invalidateRef.current?.()}
      >
        <BrushPanel />
      </ScrollArea>
      <Stack pos="relative" flex={1} h="100%" gap={0}>
        <Box pos="absolute" top={0} bottom={0} left={0} right={0} bg="dark.9" style={{ zIndex: -1 }} />
        {openFileIds.length === 0 ? (
          <EmptyState />
        ) : (
          <Box
            flex={1}
            h="100%"
            p="xs"
            style={{
              minHeight: 0,
              overflowX: "hidden",
              overflowY: fullscreenFileId ? "hidden" : "auto",
            }}
            onScroll={() => invalidateRef.current?.()}
          >
            <CanvasPanel />
          </Box>
        )}
        <TransportPanel />
      </Stack>
      <ScrollArea
        scrollbarSize={4}
        type="auto"
        w={170}
        miw={170}
        h="100%"
        onScrollPositionChange={() => invalidateRef.current?.()}
      >
        <ControlsPanel />
      </ScrollArea>
      <Notifications />
      <UpdateNotification />
    </Group>
  );
}

export default App;
