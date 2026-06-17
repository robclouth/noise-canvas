import { BrushPanel } from "@/components/layout/brush-panel";
import { SidebarPanel } from "@/components/layout/sidebar-panel";
import { useStore } from "@/store";
import { Box, Group, LoadingOverlay, Progress, ScrollArea, Stack, Text } from "@mantine/core";
import { Notifications } from "@mantine/notifications";
import { View } from "@react-three/drei";
import { Canvas, RootState, useThree } from "@react-three/fiber";
import { useCallback, useEffect, useRef, useState } from "react";
import { useDropzone } from "react-dropzone";
import { EmptyState } from "./components/empty-state";
import { CanvasPanel, PaletteBar } from "./components/layout/canvas-panel";
import { ExtensionMenuBar } from "./components/layout/menu-bar";
import { TransportPanel } from "./components/layout/transport-panel";
import { UpdateNotification } from "./components/update-notification";
import { host } from "./lib/host";
import { ipcOn, ipcSend } from "./lib/ipc";
import { BRUSH_PANEL_WIDTH } from "./lib/ui-density";
import { precompileAllShaders, warmEffectPipelines } from "./lib/precompile-shaders";
import { clearAllHistoryManagers, getHistoryManager, pruneOrphanHistoryDirs } from "./lib/history-manager";
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

const ShaderCompiler = ({
  onProgress,
  onFinish,
}: {
  onProgress: (done: number, total: number) => void;
  onFinish: () => void;
}) => {
  const gl = useThree((s) => s.gl);
  useEffect(() => {
    let cancelled = false;
    // Link programs (fast), then warm each effect's pipeline state on a worker.
    // The loading overlay stays up with per-shader progress until warming is
    // done, since the effects can't be used until their shaders are compiled.
    precompileAllShaders(gl)
      .catch((err) => {
        console.error("Shader linking failed:", err);
      })
      .finally(() => {
        if (cancelled) return;
        warmEffectPipelines({
          onProgress: (done, total) => {
            if (!cancelled) onProgress(done, total);
          },
          onDone: () => {
            if (!cancelled) onFinish();
          },
        });
      });
    return () => {
      cancelled = true;
    };
  }, [gl, onProgress, onFinish]);
  return null;
};

function App(): React.JSX.Element {
  useShortcuts();
  useLinkSync();
  const [isReady, setIsReady] = useState(false);
  const [shaderProgress, setShaderProgress] = useState<{ done: number; total: number } | null>(null);
  const openFileIds = useStore((state) => state.openFileIds);
  const fullscreenFileId = useStore((state) => state.fullscreenFileId);
  const uiSize = useStore((state) => state.uiSize);

  const invalidateRef = useRef<Invalidator | null>(null);

  useEffect(() => {
    invalidateRef.current?.();
  }, [fullscreenFileId]);

  // Drive the density CSS variables and keep the native menu checkmark in sync.
  useEffect(() => {
    document.documentElement.dataset.uiSize = uiSize;
    ipcSend("update-ui-size", uiSize === "sm");
  }, [uiSize]);

  useEffect(() => {
    useStore.getState().init();
    // Best-effort cleanup of history dirs left behind by crashes or other
    // close paths that didn't call destroyHistoryManager. Runs after persisted
    // state is loaded so we know which fileIds are still alive.
    void pruneOrphanHistoryDirs(new Set(Object.keys(useStore.getState().persistedFilePaths)));
  }, []);

  useEffect(() => {
    const unsubscribers: (() => void)[] = [];

    // Development file loading
    if (host.env.nodeEnv === "development") {
      const { openFilePath, openFileIds } = useStore.getState();
      if (openFileIds.length === 0) {
        openFilePath(
          "/Users/rob/Splice/sounds/packs/Fresh Mint, a Rohaan moment/Moment_Rohaan_Fresh_Mint/loops/drum_loops/full_drum_loops/MO_RO_140_drum_loop_robust_shed.wav",
        );
        // openFilePath(
        //   "/Users/rob/Splice/sounds/packs/lofi crates./Origin_Sound__-_lofi_crates/loops/vocals_loops/OS_LFC_80_vocal_backing_honey_A#m.wav",
        // );
        // openFilePath("/Users/rob/Documents/Projects/Music/Samples/local women singing at the clinic.mp3");
        // openFilePath(
        //   "/Users/rob/Splice/sounds/packs/The Jungle Drummer - Breakbeat Culture/Test_Press_-_The_Jungle_Drummer_-_Breakbeat_Culture/Loops/Layered_Breaks/TSP_TJD_172_break_layered_2snare_junglism.wav",
        // );
        openFilePath(host.env.cwd() + "/test-audio/tone-440hz-5s.wav");
      }
    }

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

    const pushRecentFiles = (paths: string[]) => {
      ipcSend("update-recent-files", paths);
    };
    pushRecentFiles(useStore.getState().recentFilePaths);
    const unsubRecentFiles = useStore.subscribe((state) => state.recentFilePaths, pushRecentFiles);
    unsubscribers.push(unsubRecentFiles);

    const unsubClearRecent = ipcOn("clear-recent-files", () => {
      useStore.getState().clearRecentFilePaths();
    });
    unsubscribers.push(unsubClearRecent);

    const unsubToggleUiSize = ipcOn("toggle-ui-size", () => {
      useStore.getState().toggleUiSize();
    });
    unsubscribers.push(unsubToggleUiSize);

    const unsubNewFile = ipcOn("new-file", async () => {
      const { newFile } = useStore.getState();
      await newFile();
    });
    unsubscribers.push(unsubNewFile);

    const unsubOpenFile = ipcOn("open-file", async (path) => {
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

    const unsubExportHistory = ipcOn("export-history", () => {
      const { exportHistory } = useStore.getState();
      exportHistory();
    });
    unsubscribers.push(unsubExportHistory);

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
      const historyManager = getHistoryManager(activeFileId);
      await historyManager.navigateToParent();
    });
    unsubscribers.push(unsubUndo);

    const unsubRedo = ipcOn("redo", async () => {
      const { activeFileId } = useStore.getState();
      if (!activeFileId) return;
      const historyManager = getHistoryManager(activeFileId);
      await historyManager.navigateToLastChild();
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

    const unsubDoubleActiveFileLength = ipcOn("double-active-file-length", () => {
      useStore.getState().resizeActiveFileLength(2);
    });
    unsubscribers.push(unsubDoubleActiveFileLength);

    const unsubHalveActiveFileLength = ipcOn("halve-active-file-length", () => {
      useStore.getState().resizeActiveFileLength(0.5);
    });
    unsubscribers.push(unsubHalveActiveFileLength);

    const unsubAppWillQuit = ipcOn("app-will-quit", async () => {
      clearAllHistoryManagers();
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
    const filePath = host.files.getPathForFile(acceptedFiles[0]);
    useStore.getState().openFilePath(filePath);
  }, []);

  const handleShaderCompileFinish = useCallback(() => {
    setIsReady(true);
  }, []);

  const handleShaderProgress = useCallback((done: number, total: number) => {
    setShaderProgress({ done, total });
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
    <Stack h="100vh" w="100vw" gap={0}>
      <ExtensionMenuBar />
      <Group flex={1} mih={0} w="100vw" wrap="nowrap" gap={0} {...getRootProps()}>
        <LoadingOverlay
          visible={!isReady}
          zIndex={10001}
          loaderProps={{
            children: (
              <Stack align="center" gap="sm">
                {shaderProgress ? (
                  <>
                    <Text size="sm" c="dimmed">
                      Optimizing shaders… {shaderProgress.done}/{shaderProgress.total}
                    </Text>
                    <Progress
                      w={220}
                      value={shaderProgress.total ? (shaderProgress.done / shaderProgress.total) * 100 : 0}
                      transitionDuration={200}
                    />
                    <Text size="xs" c="dimmed">
                      This only takes a while the first time.
                    </Text>
                  </>
                ) : (
                  <Text size="sm" c="dimmed">
                    Loading…
                  </Text>
                )}
              </Stack>
            ),
          }}
        />
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

          <ShaderCompiler onProgress={handleShaderProgress} onFinish={handleShaderCompileFinish} />
        </Canvas>
        <ScrollArea
          scrollbarSize={4}
          type="auto"
          h="100%"
          w={BRUSH_PANEL_WIDTH}
          style={{ flexShrink: 0 }}
          onScrollPositionChange={() => invalidateRef.current?.()}
        >
          <BrushPanel />
        </ScrollArea>
        <Stack pos="relative" flex={1} h="100%" gap={0}>
          <Box pos="absolute" top={0} bottom={0} left={0} right={0} bg="dark.9" style={{ zIndex: -1 }} />
          {openFileIds.length === 0 ? (
            <EmptyState />
          ) : (
            <ScrollArea
              type="auto"
              scrollbarSize={4}
              scrollbars="y"
              h="100%"
              style={{ flex: 1, minHeight: 0 }}
              viewportProps={{ style: { overflowY: fullscreenFileId ? "hidden" : undefined } }}
              onScrollPositionChange={() => invalidateRef.current?.()}
            >
              <Box p="xs">
                <CanvasPanel />
              </Box>
            </ScrollArea>
          )}
          <PaletteBar />
          <TransportPanel />
        </Stack>
        <SidebarPanel />
        <Notifications />
        <UpdateNotification />
      </Group>
    </Stack>
  );
}

export default App;
