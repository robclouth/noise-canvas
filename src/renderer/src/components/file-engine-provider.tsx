import { useThree } from "@react-three/fiber";
import { useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { FileEngineRegistry, FileEngineRegistryContext } from "../lib/file-engine-registry";
import type { FileEngineContext } from "../lib/file-engine";
import { serializeFileTask } from "../lib/file-task-queue";
import { deriveSideData, getHistoryManager } from "../lib/history-manager";
import { getFileOnsets } from "../lib/file-onsets";
import { useModulatorScaleLut } from "../lib/modulator-utils";
import { useModulatorTexture, usePlaceholderTexture } from "../lib/textures";
import { createStepStateView, useStore } from "../store";
import {
  attachFileEngineRegistry,
  getOpenFileByPath,
  logFileFootprint,
  openFiles,
  registerFileEngineHandle,
} from "../store/files";
import { useTransientStore } from "../store/transient";

/** Keeps the open-file engines under the shared Canvas context. */
export function FileEngineProvider({ children }: { children?: ReactNode }) {
  const gl = useThree((state) => state.gl);
  const [contextGeneration, setContextGeneration] = useState(0);
  const ids = useStore((state) => state.openFileIds);
  const registry = useMemo(
    () =>
      new FileEngineRegistry(
        gl,
        {
          getHistoryManager,
          deriveSideData,
          serializeFileTask,
          openFiles,
          logFileFootprint,
          getState: useStore.getState,
          getTransientState: useTransientStore.getState,
        },
        registerFileEngineHandle,
        contextGeneration,
      ),
    [gl, contextGeneration],
  );
  useLayoutEffect(() => attachFileEngineRegistry(registry), [registry]);
  useLayoutEffect(() => {
    const lost = () => registry.dispose();
    const restored = () => setContextGeneration((generation) => generation + 1);
    gl.domElement.addEventListener("webglcontextlost", lost);
    gl.domElement.addEventListener("webglcontextrestored", restored);
    return () => {
      gl.domElement.removeEventListener("webglcontextlost", lost);
      gl.domElement.removeEventListener("webglcontextrestored", restored);
    };
  }, [gl, registry]);
  return (
    <FileEngineRegistryContext.Provider value={registry}>
      {ids.map((id) => (
        <FileEngineBridge key={id} id={id} registry={registry} />
      ))}
      {children}
    </FileEngineRegistryContext.Provider>
  );
}

function FileEngineBridge({ id, registry }: { id: string; registry: FileEngineRegistry }) {
  const gl = useThree((state) => state.gl);
  const invalidate = useThree((state) => state.invalidate);
  const spectrogramData = useStore(() => openFiles[id]?.spectrogramData);
  const parked = useStore((state) => state.minimizedFileIds.includes(id));
  const hasSpectrogram = Boolean(spectrogramData);
  const modulatorScaleLut = useModulatorScaleLut(id);
  const modulator1Texture = useModulatorTexture(0);
  const modulator2Texture = useModulatorTexture(1);
  const modulator3Texture = useModulatorTexture(2);
  const placeholderTexture = usePlaceholderTexture();
  const contextRef = useRef<FileEngineContext | null>(null);
  if (spectrogramData) {
    const engine = registry.get(id);
    contextRef.current = {
      spectrogramData,
      glRef: { current: gl },
      invalidateRef: { current: invalidate },
      hasDrawnDisplayRef: { current: false },
      modulatorScaleLut,
      modulator1Texture,
      modulator2Texture,
      modulator3Texture,
      placeholderTexture,
      resourcesChanged: () => {},
      scheduleSnapshotRefresh: () => registry.handle(id)?.refreshSnapshot(),
      strokeContext: {
        fileId: id,
        viewFileId: id,
        spectrogramData,
        strokeRendererRef: engine?.strokeRendererRef ?? { current: null },
        canvasRef: engine?.canvasRef ?? { current: null },
        openFiles,
        getOpenFileByPath,
        createStepStateView,
        getFileOnsets,
        closeFile: (fileId) => useStore.getState().closeFile(fileId),
        reachByState: new WeakMap(),
      },
    };
  }
  useLayoutEffect(() => {
    const context = contextRef.current;
    if (!context) return;
    registry.open(id, context, Boolean(openFiles[id]?.parked));
    return () => registry.close(id);
  }, [id, registry, hasSpectrogram]);
  useLayoutEffect(() => {
    if (contextRef.current) registry.update(id, contextRef.current);
    registry.setParked(id, parked);
  });
  useLayoutEffect(() => () => modulatorScaleLut?.dispose(), [modulatorScaleLut]);
  useLayoutEffect(() => () => placeholderTexture.dispose(), [placeholderTexture]);
  return null;
}
