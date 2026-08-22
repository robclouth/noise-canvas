import { BrushPanel } from "@/components/layout/brush-panel";
import { SidebarPanel } from "@/components/layout/sidebar-panel";
import { useStore } from "@/store";
import { Box, Group, LoadingOverlay, ScrollArea, Stack } from "@mantine/core";
import { Notifications, notifications } from "@mantine/notifications";
import { View } from "@react-three/drei";
import { Canvas, RootState, useFrame, useThree } from "@react-three/fiber";
import { useCallback, useEffect, useRef, useState } from "react";
import { useDropzone, type FileRejection } from "react-dropzone";
import { EmptyState } from "./components/empty-state";
import { openImageExportModal } from "./components/image-export-modal";
import { CanvasPanel, Dock } from "./components/layout/canvas-panel";
import { AppMenuBar } from "./components/layout/menu-bar";
import { TransportPanel } from "./components/layout/transport-panel";
import { UpdateNotification } from "./components/update-notification";
import { FillProgressModal } from "./components/fill-progress-modal";
import { HelpOverlay } from "./components/help-overlay";
import { ManualViewer } from "./components/manual-viewer";
import { Walkthrough } from "./components/walkthrough";
import { ANALYSIS_MAX_TEXTURE_SIZE } from "./lib/constants";
import { diag } from "./lib/diag-log";
import { recordDiagFrame, startDiagSampler } from "./lib/diag-sampler";
import { host } from "./lib/host";
import { ipcOn, ipcSend } from "./lib/ipc";
import { anchorProps } from "./lib/ui-anchors";
import { BRUSH_PANEL_WIDTH } from "./lib/ui-density";
import { precompileDisplayShader, precompileRemainingShaders, warmEffectPipelines } from "./lib/precompile-shaders";
import { setShaderWarmupProgress } from "./lib/shader-warmup-progress";
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

/**
 * Drives shader compilation. The app is held back only for the display shaders,
 * which take a fraction of a second; the effect programs, which take far longer
 * on Windows, are linked afterwards in the background while the app is already
 * usable, with the menu bar showing how far along they are.
 */
const ShaderCompiler = ({ onDisplayReady }: { onDisplayReady: () => void }) => {
  const gl = useThree((s) => s.gl);
  useEffect(() => {
    let cancelled = false;

    const run = async (): Promise<void> => {
      const displayT0 = performance.now();
      try {
        await precompileDisplayShader(gl);
      } catch (err) {
        console.error("Display shader linking failed:", err);
      }
      diag.timing("shaders", "display shader linked", performance.now() - displayT0);
      if (cancelled) return;
      onDisplayReady();

      // The effects the brush already holds are the ones the next stroke needs.
      const priority = useStore.getState().effects.map((item) => item.effect);
      const effectsT0 = performance.now();
      try {
        await precompileRemainingShaders(gl, priority, setShaderWarmupProgress);
      } catch (err) {
        console.error("Effect shader linking failed:", err);
      }
      diag.timing("shaders", "effect shaders linked", performance.now() - effectsT0);
      if (cancelled) return;
      const warmT0 = performance.now();
      warmEffectPipelines({
        onProgress: setShaderWarmupProgress,
        onDone: () => {
          setShaderWarmupProgress(0, 0);
          diag.timing("shaders", "effect pipelines warmed", performance.now() - warmT0);
        },
      });
    };

    void run();
    return () => {
      cancelled = true;
    };
  }, [gl, onDisplayReady]);
  return null;
};

const navigatorWithMemory: Navigator & { deviceMemory?: number } = navigator;

/**
 * Logs the WebGL context's identity and limits once, reports context loss,
 * feeds the frame-cadence probe and runs the memory sampler.
 */
const DiagProbe = () => {
  const gl = useThree((s) => s.gl);
  useEffect(() => {
    const context = gl.getContext();
    const debugInfo = context.getExtension("WEBGL_debug_renderer_info");
    const maxTextureSize: number = context.getParameter(context.MAX_TEXTURE_SIZE);
    const colorBufferFloat = context.getExtension("EXT_color_buffer_float") !== null;
    diag.info("gl", "context", {
      renderer: debugInfo
        ? context.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL)
        : context.getParameter(context.RENDERER),
      vendor: debugInfo ? context.getParameter(debugInfo.UNMASKED_VENDOR_WEBGL) : context.getParameter(context.VENDOR),
      version: context.getParameter(context.VERSION),
      maxTextureSize,
      maxRenderbufferSize: context.getParameter(context.MAX_RENDERBUFFER_SIZE),
      colorBufferFloat,
      textureFloatLinear: context.getExtension("OES_texture_float_linear") !== null,
      devicePixelRatio: window.devicePixelRatio,
      windowWidth: window.innerWidth,
      windowHeight: window.innerHeight,
      hardwareConcurrency: navigator.hardwareConcurrency,
      deviceMemoryGB: navigatorWithMemory.deviceMemory ?? null,
    });

    // The spectrogram lives in float render targets up to 8192 texels wide;
    // a device without either cannot paint at all.
    if (!colorBufferFloat || maxTextureSize < ANALYSIS_MAX_TEXTURE_SIZE) {
      diag.error("gl", "device cannot render the spectrogram", { colorBufferFloat, maxTextureSize });
      notifications.show({
        title: "Graphics device not supported",
        message: "This graphics device cannot hold the spectrogram, so files will not open or paint.",
        color: "red",
        autoClose: false,
      });
    }

    const canvas = gl.domElement;
    const onLost = (event: Event): void => {
      const statusMessage = event instanceof WebGLContextEvent ? event.statusMessage : "";
      diag.error("gl", "context lost", { statusMessage });
    };
    const onRestored = (): void => {
      diag.info("gl", "context restored");
    };
    canvas.addEventListener("webglcontextlost", onLost);
    canvas.addEventListener("webglcontextrestored", onRestored);
    const stopSampler = host.env.isExtension ? () => {} : startDiagSampler(gl);
    return () => {
      canvas.removeEventListener("webglcontextlost", onLost);
      canvas.removeEventListener("webglcontextrestored", onRestored);
      stopSampler();
    };
  }, [gl]);

  useFrame(() => {
    recordDiagFrame(performance.now());
  });
  return null;
};

function App(): React.JSX.Element {
  useShortcuts();
  useLinkSync();
  const [isReady, setIsReady] = useState(false);
  const openFileIds = useStore((state) => state.openFileIds);
  const fullscreenFileId = useStore((state) => state.fullscreenFileId);
  const uiSize = useStore((state) => state.uiSize);

  const invalidateRef = useRef<Invalidator | null>(null);

  useEffect(() => {
    invalidateRef.current?.();
  }, [fullscreenFileId]);

  // Drive the density CSS variables.
  useEffect(() => {
    document.documentElement.dataset.uiSize = uiSize;
  }, [uiSize]);

  useEffect(() => {
    useStore.getState().init();
    void useStore.getState().initSectionPresets();
    void useStore.getState().initPalettes();
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

    const unsubExportImage = ipcOn("export-image", () => {
      const { activeFileId } = useStore.getState();
      if (activeFileId) openImageExportModal(activeFileId);
    });
    unsubscribers.push(unsubExportImage);

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

    const unsubFillGrid = ipcOn("fill-grid", () => {
      void useStore.getState().fillGrid();
    });
    unsubscribers.push(unsubFillGrid);

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
      // The canvas is the analysis again, so it holds no unprojected paint.
      file.unprojectedPaint = false;
      // restore-original bypasses history, so the FBO no longer matches the
      // history's current node; navigation must not patch on top of it.
      getHistoryManager(activeFileId).markFboOutOfSync();
    });
    unsubscribers.push(unsubRestoreOriginal);

    const unsubDoubleActiveFileLength = ipcOn("double-active-file-length", () => {
      useStore.getState().resizeActiveFileLength(2);
    });
    unsubscribers.push(unsubDoubleActiveFileLength);

    const unsubHalveActiveFileLength = ipcOn("halve-active-file-length", () => {
      useStore.getState().resizeActiveFileLength(0.5);
    });
    unsubscribers.push(unsubHalveActiveFileLength);

    const unsubAppWillQuit = ipcOn("app-will-quit", () => {
      // Main holds the quit until this reports back (or times out).
      void clearAllHistoryManagers().finally(() => ipcSend("quit-cleanup-done"));
    });
    unsubscribers.push(unsubAppWillQuit);

    // Main holds a file the app was launched with until this arrives, because
    // did-finish-load can fire before this effect installs the listeners above.
    ipcSend("renderer-ready");

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

  const onDropRejected = useCallback((rejections: FileRejection[]) => {
    if (rejections.length === 0) return;
    const tooMany = rejections.length > 1;
    notifications.show({
      title: tooMany ? "One file at a time" : "Unsupported file",
      message: tooMany
        ? "Drop a single audio file, or use File ▸ Open to add several."
        : `${rejections[0].file.name} is not an audio format Noise Canvas can open.`,
      color: "yellow",
    });
  }, []);

  const handleDisplayShadersReady = useCallback(() => {
    setIsReady(true);
  }, []);

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    onDropRejected,
    getFilesFromEvent: async (event) => {
      return Array.from((event as any).dataTransfer.files);
    },
    multiple: false,
    accept: { "audio/*": [] },
    noClick: true,
    noKeyboard: true,
    // The extension's webview cannot resolve a dropped File to a path, so it
    // offers no drop target rather than swallowing the drop.
    disabled: !host.files.canResolveDroppedPaths,
  });

  return (
    <Stack h="100vh" w="100vw" gap={0}>
      <AppMenuBar />
      <Group flex={1} mih={0} w="100vw" wrap="nowrap" gap={0} {...getRootProps()}>
        <LoadingOverlay visible={!isReady} zIndex={10001} overlayProps={{ blur: 8, backgroundOpacity: 0.6 }} />
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
          <DiagProbe />

          <ShaderCompiler onDisplayReady={handleDisplayShadersReady} />
        </Canvas>
        <ScrollArea
          scrollbarSize={4}
          type="auto"
          h="100%"
          w={BRUSH_PANEL_WIDTH}
          style={{ flexShrink: 0 }}
          onScrollPositionChange={() => invalidateRef.current?.()}
          {...anchorProps("brush-panel")}
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
              // The scroll viewport's content wrapper sizes to its content, which
              // breaks a percentage height chain, so a fullscreen lane gets a flex
              // column to grow into instead.
              styles={
                fullscreenFileId ? { content: { height: "100%", display: "flex", flexDirection: "column" } } : undefined
              }
              onScrollPositionChange={() => invalidateRef.current?.()}
            >
              <Box
                p="xs"
                style={
                  fullscreenFileId ? { flex: 1, minHeight: 0, display: "flex", flexDirection: "column" } : undefined
                }
              >
                <CanvasPanel />
              </Box>
            </ScrollArea>
          )}
          <Dock />
          <TransportPanel />
        </Stack>
        <SidebarPanel />
        <Notifications />
        <UpdateNotification />
        <Walkthrough ready={isReady} />
        <ManualViewer />
        <HelpOverlay />
        <FillProgressModal />
      </Group>
    </Stack>
  );
}

export default App;
