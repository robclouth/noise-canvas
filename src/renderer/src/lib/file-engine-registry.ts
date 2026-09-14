import type { WebGLRenderer } from "three";
import { createContext } from "react";
import { FileEngine, type FileEngineContext, type FileEngineServices } from "./file-engine";
import { visibleFrameRange } from "./file-display-residency";
import type { FileRendererHandle } from "./file-renderer-types";

type ViewOperations = Pick<FileRendererHandle, "renderStroke" | "clearPreview">;
interface Entry {
  engine: FileEngine;
  context: FileEngineContext;
  generation: number;
  adapter: FileRendererHandle | null;
  operations: ReturnType<FileEngine["fileOperations"]> | null;
  view: ViewOperations | null;
  cancelPrepare?: () => void;
  cancelParking?: () => void;
  parked: boolean;
  reloading: boolean;
}

export const FileEngineRegistryContext = createContext<FileEngineRegistry | null>(null);

/** Owns file engines and their compatibility handles for one shared graphics context. */
export class FileEngineRegistry {
  private readonly entries = new Map<string, Entry>();
  private readonly listeners = new Set<() => void>();
  private revision = 0;
  constructor(
    readonly gl: WebGLRenderer,
    private readonly services: FileEngineServices,
    private readonly register: (id: string, handle: FileRendererHandle | null) => void,
    readonly contextGeneration = 0,
  ) {}
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  snapshot = (): number => this.revision;
  private changed = (): void => {
    this.revision++;
    for (const listener of this.listeners) listener();
  };
  get = (id: string): FileEngine | null => this.entries.get(id)?.engine ?? null;
  handle = (id: string): FileRendererHandle | null => this.entries.get(id)?.adapter ?? null;
  open(id: string, context: FileEngineContext, parked: boolean): FileEngine {
    if (context.glRef.current !== this.gl) throw new Error("File engine belongs to another graphics context");
    const existing = this.entries.get(id);
    if (existing) return existing.engine;
    const engine = new FileEngine(id, this.services, parked);
    const entry: Entry = {
      engine,
      context,
      generation: 0,
      adapter: null,
      operations: null,
      view: null,
      parked,
      reloading: false,
    };
    this.entries.set(id, entry);
    context.resourcesChanged = () => this.resourcesChanged(id, entry);
    context.strokeContext.strokeRendererRef = engine.strokeRendererRef;
    context.strokeContext.canvasRef = engine.canvasRef;
    engine.updateContext(context);
    entry.cancelPrepare = engine.prepare(parked);
    if (parked) entry.cancelParking = engine.park();
    this.changed();
    return engine;
  }
  update(id: string, context: FileEngineContext): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    context.resourcesChanged = entry.context.resourcesChanged;
    entry.context = context;
    entry.engine.updateContext(context);
    if (entry.adapter) entry.operations = entry.engine.fileOperations();
    entry.engine.strokeRendererRef.current?.updateModulatorTextures(
      context.modulator1Texture,
      context.modulator2Texture,
      context.modulator3Texture,
      context.modulatorScaleLut,
    );
    context.invalidateRef.current();
  }
  private resourcesChanged(id: string, entry: Entry): void {
    if (this.entries.get(id) !== entry) return;
    const renderer = entry.engine.initialise(() => {
      const state = this.services.getState();
      return visibleFrameRange({
        spectrogramData: entry.context.spectrogramData,
        transform: { viewZoomPower: state.filesZoom[id] ?? 0, viewOffset: state.filesOffset[id] ?? 0 },
      });
    }, !entry.reloading);
    if (renderer && !entry.adapter) {
      entry.operations = entry.engine.fileOperations();
      const viewOperations = {
        reloadTextures: () => this.reload(id),
        renderStroke: (preview: boolean) => entry.view?.renderStroke(preview),
        clearPreview: () => entry.view?.clearPreview(),
      };
      entry.adapter = new Proxy(
        { ...entry.operations, ...viewOperations },
        {
          get: (target, key, receiver) =>
            key in viewOperations ? Reflect.get(target, key, receiver) : Reflect.get(entry.operations ?? target, key),
        },
      );
      this.register(id, entry.adapter);
    }
    entry.engine.notifyResidencyChanged();
    this.changed();
  }
  bindView(id: string, view: ViewOperations): () => void {
    const entry = this.entries.get(id);
    if (!entry) return () => {};
    entry.view = view;
    return () => {
      if (entry.view !== view) return;
      entry.view = null;
    };
  }
  setParked(id: string, parked: boolean): void {
    const entry = this.entries.get(id);
    if (!entry || entry.parked === parked) return;
    entry.parked = parked;
    entry.cancelParking?.();
    entry.cancelParking = parked ? entry.engine.park() : entry.engine.resume();
  }
  reload(id: string): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    entry.generation++;
    entry.cancelPrepare?.();
    entry.cancelPrepare = undefined;
    entry.cancelParking?.();
    entry.cancelParking = undefined;
    entry.reloading = true;
    try {
      entry.engine.reloadTextures();
    } finally {
      entry.reloading = false;
    }
  }
  close(id: string): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    this.entries.delete(id);
    this.register(id, null);
    entry.cancelPrepare?.();
    entry.cancelParking?.();
    entry.engine.dispose();
    entry.view = null;
    this.changed();
  }
  dispose(): void {
    for (const id of this.entries.keys()) this.close(id);
  }
  diagnostics(): Array<{ id: string; generation: number; engine: FileEngine }> {
    return Array.from(this.entries, ([id, entry]) => ({ id, generation: entry.generation, engine: entry.engine }));
  }
}
