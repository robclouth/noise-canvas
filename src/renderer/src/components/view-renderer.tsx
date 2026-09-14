import { useFrame, useThree } from "@react-three/fiber";
import {
  forwardRef,
  memo,
  useCallback,
  useContext,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type RefObject,
} from "react";
import { useStore } from "../store";
import { useTransientStore } from "../store/transient";
import { FileEngineRegistryContext } from "../lib/file-engine-registry";
import type { FileRendererHandle } from "../lib/file-renderer-types";
import { savedViewTransform, ViewDisplay, type ViewDescriptor } from "../lib/view-display";
import { captureCompositionToCanvas } from "../lib/snapshot-capture";
import { ViewSnapshot } from "../lib/view-snapshot";
import { perfAdd, perfEnabled, perfSyncEnabled } from "../lib/perf-probe";
import { prepareFileEditor } from "./file-renderer";

export interface ViewRendererHandle {
  display: ViewDisplay;
  captureSnapshot: () => Promise<boolean>;
  refreshSnapshot: () => void;
}
export interface ViewRendererProps {
  descriptor: Pick<ViewDescriptor, "topId" | "layerIds">;
  isLive: boolean;
  parked: boolean;
  snapshotCanvasRef: RefObject<HTMLCanvasElement | null>;
  onLiveFrame?: () => void;
  onSnapshotRefresh?: () => void;
  onFileHandle?: (handle: FileRendererHandle | null) => void;
}

/** Prepares and draws one view of borrowed file engines. */
export const ViewRenderer = memo(
  forwardRef<ViewRendererHandle, ViewRendererProps>((props, ref) => {
    const registry = useContext(FileEngineRegistryContext);
    if (!registry) throw new Error("ViewRenderer requires the shared engine provider");
    const { onFileHandle } = props;
    const topId = props.descriptor.topId;
    const engineRevision = useSyncExternalStore(registry.subscribe, registry.snapshot);
    const gl = useThree((state) => state.gl);
    const scene = useThree((state) => state.scene);
    const dpr = useThree((state) => state.viewport.dpr);
    const invalidate = useThree((state) => state.invalidate);
    const [initialDescriptor] = useState(() => ({
      ...props.descriptor,
      transform: savedViewTransform(useStore.getState(), topId),
    }));
    const latest = useRef(props);
    latest.current = props;
    const dirty = useRef(true);
    const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const refresh = useRef<() => void>(() => {});
    const scheduleSnapshot = useRef<() => void>(() => {});
    const { display, snapshot } = useMemo(
      () => ({
        display: new ViewDisplay(registry, initialDescriptor, () => refresh.current()),
        snapshot: new ViewSnapshot(() => scheduleSnapshot.current()),
      }),
      [registry, initialDescriptor],
    );
    const scheduleSnapshotRefresh = () => {
      dirty.current = true;
      invalidate();
      if (latest.current.isLive || timer.current !== null) return;
      timer.current = setTimeout(() => {
        timer.current = null;
        if (!latest.current.isLive) latest.current.onSnapshotRefresh?.();
      }, 150);
    };
    scheduleSnapshot.current = scheduleSnapshotRefresh;
    refresh.current = () => {
      snapshot.invalidate();
      scheduleSnapshotRefresh();
    };
    const resize = useCallback(() => {
      const rect = latest.current.snapshotCanvasRef.current?.getBoundingClientRect();
      if (rect)
        display.resize(Math.round(rect.width * gl.getPixelRatio()), Math.round(rect.height * gl.getPixelRatio()));
    }, [display, gl]);
    const captureSnapshot = async (): Promise<boolean> => {
      const canvas = latest.current.snapshotCanvasRef.current;
      if (!canvas || latest.current.parked) return false;
      resize();
      if (display.width < 2 || display.height < 2) return false;
      display.prepare(useStore.getState());
      if (!display.top?.ready) return false;
      dirty.current = false;
      const { width, height } = display;
      return snapshot.capture((canPublish) =>
        captureCompositionToCanvas(
          gl,
          () => display.compose(gl, "capture"),
          canvas,
          width,
          height,
          () =>
            canPublish() &&
            !latest.current.parked &&
            latest.current.snapshotCanvasRef.current === canvas &&
            display.width === width &&
            display.height === height &&
            Boolean(display.top?.ready),
        ),
      );
    };
    const capture = useRef(captureSnapshot);
    capture.current = captureSnapshot;
    useImperativeHandle(
      ref,
      () => ({ display, captureSnapshot: () => capture.current(), refreshSnapshot: () => refresh.current() }),
      [display],
    );
    useLayoutEffect(() => {
      const state = useStore.getState();
      display.update({ ...props.descriptor, transform: savedViewTransform(state, topId) }, state);
      resize();
      refresh.current();
    }, [display, props.descriptor, topId, engineRevision, resize]);
    useLayoutEffect(() => {
      const id = topId;
      const engine = registry.get(id);
      const handle = registry.handle(id);
      onFileHandle?.(handle);
      if (!engine || !handle) return;
      const clearPreview = () => {
        engine.displayMode.current = "committed";
        if (engine.strokePreview.current) engine.applyStroke.current = false;
        invalidate();
      };
      const detach = registry.bindView(id, {
        renderStroke: (preview) => {
          if (preview && useStore.getState().pickingFileParam !== null) {
            clearPreview();
            return;
          }
          engine.strokePreview.current = preview;
          if (preview) engine.displayMode.current = "preview";
          engine.applyStroke.current = true;
          invalidate();
        },
        clearPreview,
        applyStroke: () => {
          engine.applyStroke.current = true;
          invalidate();
        },
        captureSnapshot: () => capture.current(),
        refreshSnapshot: () => refresh.current(),
      });
      const unsubscribe = useStore.subscribe(
        (state) => state.activeFileId,
        (activeId) => {
          if (activeId !== id) clearPreview();
          else {
            const { cursorVisible, cursorPosition } = useTransientStore.getState();
            if (cursorVisible && cursorPosition) {
              engine.strokePreview.current = true;
              engine.displayMode.current = "preview";
              engine.applyStroke.current = true;
            }
            invalidate();
          }
        },
      );
      return () => {
        detach();
        unsubscribe();
        onFileHandle?.(null);
      };
    }, [registry, topId, onFileHandle, engineRevision, invalidate]);
    useEffect(() => {
      const unsubscribe = useStore.subscribe((state) => {
        display.updateTransform(savedViewTransform(state, display.descriptor.topId));
        display.updateState(state);
        invalidate();
      });
      const transient = useTransientStore.subscribe(() => invalidate());
      return () => {
        unsubscribe();
        transient();
      };
    }, [display, invalidate]);
    useEffect(() => {
      const canvas = props.snapshotCanvasRef.current;
      const observer = new ResizeObserver(() => {
        resize();
        refresh.current();
      });
      if (canvas) observer.observe(canvas);
      const resized = () => {
        resize();
        refresh.current();
      };
      window.addEventListener("resize", resized);
      return () => {
        observer.disconnect();
        window.removeEventListener("resize", resized);
      };
    }, [display, props.snapshotCanvasRef, resize]);
    useEffect(() => {
      const before = scene.onBeforeRender,
        after = scene.onAfterRender;
      scene.onBeforeRender = () => {
        if (latest.current.isLive && !latest.current.parked) display.compose(gl, "live");
      };
      scene.onAfterRender = () => {
        if (latest.current.isLive && display.top?.ready) latest.current.onLiveFrame?.();
      };
      return () => {
        scene.onBeforeRender = before;
        scene.onAfterRender = after;
      };
    }, [display, gl, scene]);
    useEffect(() => {
      resize();
    }, [resize, dpr]);
    useEffect(() => {
      if (props.isLive) invalidate();
    }, [props.isLive, invalidate]);
    useEffect(
      () => () => {
        if (timer.current !== null) clearTimeout(timer.current);
        snapshot.dispose();
        display.dispose();
      },
      [display, snapshot],
    );
    useFrame(({ clock }) => {
      if (latest.current.parked || (!latest.current.isLive && !dirty.current)) return;
      const started = perfEnabled() ? performance.now() : 0;
      const state = useStore.getState();
      const wasDirty = dirty.current;
      display.prepare(state);
      const top = display.top;
      if (latest.current.isLive && top?.ready) {
        prepareFileEditor(
          top.engine,
          top.residency,
          state,
          useTransientStore.getState(),
          gl,
          clock.elapsedTime,
          invalidate,
          () => display.bind(top, state),
        );
      } else if (wasDirty || dirty.current) scheduleSnapshot.current();
      if (perfEnabled()) {
        if (perfSyncEnabled()) gl.getContext().finish();
        perfAdd("viewFramePrepare", performance.now() - started);
      }
    });
    return null;
  }),
);
ViewRenderer.displayName = "ViewRenderer";
