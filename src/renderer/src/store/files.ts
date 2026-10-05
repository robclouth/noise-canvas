import type { FileEngineRegistry } from "../lib/file-engine-registry";
import type { FileRendererHandle } from "../lib/file-renderer-types";
import { CoarseStripBuilder, coarseStripLevel } from "../lib/coarse-strip";
import {
  openConfirm,
  openStackFilesPrompt,
  openInsertSilencePrompt,
  openNewFilePrompt,
  openSetLengthPrompt,
} from "../lib/modals";
import { notifications } from "@mantine/notifications";
import truncateMiddle from "@stdlib/string-truncate-middle";
import { EffectItem } from "@renderer/effects/types";
import { FileParameterValue, getFileParameterKeys, parameterDefs } from "@renderer/parameters";
import { produce } from "immer";
import { Vector2 } from "three";
import * as Tone from "tone";
import { host } from "../lib/host";
import { diag } from "../lib/diag-log";
import {
  canvasExtraSlotBlocks,
  canvasPaintExtraSlotBlocks,
  canvasWindowBlocks,
  remainingCoefficientBudget,
  usedBudgetFraction,
  type OpenFileTexels,
} from "../lib/gpu-budget";
import { blockBandLayout, blockGrid, blockTexels, frameRangeOfBlock, type BlockGrid } from "../lib/block-grid";
import { destroyBlockStore, getBlockStore, openBlockStore } from "../lib/block-stores";
import { needsCanvasWindow } from "../lib/canvas-window";
import { viewCoversFile } from "../lib/canvas-view";
import {
  SYNTHESIS_CHUNK_SECONDS,
  synthesiseInChunks,
  synthesisViewOf,
  type ChunkOnsetPass,
  type SynthesiseView,
} from "../../../main/lib/synthesis-chunks";
import { toChannelCount } from "../lib/channel-mix";
import { mixdown } from "../lib/mixdown";
import { resampleChannels } from "../lib/resample";
import { insertSilence, silenceCutSample } from "../lib/insert-silence";
import { lengthToSeconds, type LengthValues } from "../lib/length-values";
import { setChannelsLength } from "../lib/set-length";
import { insertOnsetSpan, insertSpanPieces, removeOnsetSpan } from "../../../main/lib/ripple-edits";
import { fullHeightSelection, type Selection } from "../lib/selection";
import { isBundledPath, resolveBundledPath } from "../lib/bundled-samples";
import type {
  AnalysisParams,
  CommitLevels,
  CommitStrokeResult,
  PackedLayout,
  PackedOnsets,
  SplicePiece,
} from "../../../main/lib/types";
import { applyPhaseTurns, hasPhaseTurns } from "../../../main/lib/history-delta";
import { commitViewOf, composeViewBuffer, scatterCommitPatch, viewHolds, type CommitView } from "../lib/commit-view";
import { copyCompactOverlap, gatherPixelRanges, scatterCompactPixelRanges } from "../lib/pixel-ranges";
import {
  computeOutputLevels,
  measureOutputLevels,
  outputLevelPoints,
  spliceOutputLevels,
  type OutputLevels,
} from "../lib/output-levels";
import { applyAudioEdits, buildAudioHop, type AudioEdit, type AudioHop, type AudioStateMeta } from "../lib/audio-hop";
import { bandLayoutOf, bandLengthsTexels, type BandLayout } from "../lib/band-layout";
import { packedTextureSizeOf } from "../lib/canvas-view";
import { ONSET_REGION_PAD_SEC } from "../lib/constants";
import { gatherFileIds, gatherFileGroups, reorderFileIds } from "../lib/file-reorder";
import type { HostRender } from "../lib/host/types";
import { destroyHistoryManager, getHistoryManager, type PreparedDelta } from "../lib/history-manager";
import { serializeEditCommand, serializeFileTask } from "../lib/file-task-queue";
import { buildChildIndexPaths, chainFromRootTo, runHistoryExport } from "../lib/history-export";
import { disposeOnsetTexture, packOnsetState, spliceOnsets, unpackOnsetState } from "../lib/onset-map";
import { commitStrokeOf, commitWindowOf, projectsWholeFile, type StrokeCommitSnapshot } from "../lib/stroke-commit";
import type {
  Brush,
  LoopRegion,
  OpenFile,
  ParameterKey,
  SpectrogramData,
  State,
  ZustandGet,
  ZustandSet,
} from "./types";

/** The audio side of any synthesis, whichever pass produced it. */
interface SynthesisAudioResult {
  channels: Float32Array[];
  peak: number;
  gainReductionDb?: Float32Array;
  maxGainReductionDb?: number;
  /** Peak level per 5 ms hop over the whole buffer, and where it overloads. */
  outputLevels?: OutputLevels;
  onsets?: PackedOnsets;
  onsetOdfMax?: number;
  onsetBandMax?: Float32Array;
}
import { selectLayerStack, selectStackLayerIds, layerColor, type LayerStackMethod } from "./layers";
import { hasSupportedAudioExtension } from "../../../main/lib/audio-extensions";
import { generateFileId, isManagedFilePath, makeManagedFilePath } from "./utils";

/** What a finished commit hands back: the addon's result, the audio it installed, and the hop for history. */
export interface CommitOutcome {
  result: CommitStrokeResult;
  audioBuffer: AudioBuffer | null;
  audioHop: AudioHop | null;
  /** The view a windowed commit ran on, with `viewBuffer` holding its pixels after the commit. */
  view: CommitView | null;
  viewBuffer: Float32Array | null;
  /** The whole painted state, when the commit had to read or was handed one. */
  data: Float32Array | null;
  /** The stroke's delta, cut from the view before the stroke went over it. */
  preparedDelta: PreparedDelta | null;
  /** The footprint's pre-stroke values, when the commit read them and cut no delta. */
  baseFootprint: Float32Array | null;
}

/** What a commit reads the painted state from: the whole canvas, or the stroke's footprint over the block store. */
export interface CommitSource {
  data: Float32Array | null;
  footprint: { ranges: Uint32Array; values: Float32Array | Promise<Float32Array> } | null;
}

export interface FilesState {
  newFile: () => Promise<void>;
  openFileIds: string[];
  openFilePath: (filePath: string) => Promise<void>;
  duplicateFile: (fileId: string) => Promise<void>;
  hpssFile: (fileId: string) => Promise<void>;
  aiSeparateFile: (fileId: string) => Promise<void>;
  nmfFile: (fileId: string, numComponents: number) => Promise<void>;
  /** Sum the given files into a new one, leaving the originals open. */
  /** Asks which open files to bracket together, then brackets them. */
  promptStackFiles: () => Promise<void>;
  /** Brackets the given open files together, moving them into one run of lanes. */
  stackFiles: (fileIds: string[]) => void;
  /**
   * Adds a silent layer on `fileId`'s grid, in its stack, making one when the
   * file has none. The shared grid is what keeps a merge an exact sum.
   */
  addEmptyLayer: (fileId: string) => Promise<void>;
  /** Drops the bracket around the active file's group, if it is in one. */
  unstackActiveFile: () => void;
  mergeFiles: (fileIds: string[]) => Promise<void>;
  mergeLayerStack: (stackId: string) => Promise<void>;
  /** Close every member of a group, after one confirmation covering all of them. */
  closeLayerStack: (stackId: string) => Promise<void>;
  saveActiveFile: () => Promise<void>;
  saveActiveFileAs: () => Promise<void>;
  saveActiveFileVersion: () => Promise<void>;
  tryCloseFile: (fileId: string) => Promise<void>;
  closeFile: (fileId: string) => void;
  /** Analyse a file again at a new resolution, keeping its audio and history. */
  reanalyzeFile: (fileId: string, bandsPerOctave: number) => Promise<void>;
  resizeActiveFileLength: (factor: 2 | 0.5) => Promise<void>;
  /** Ask for a length and a place, then splice that much silence into the active file. */
  /** Asks for a length, then cuts the active file to it or pads it with silence. */
  setActiveFileLength: () => Promise<void>;
  insertSilenceIntoActiveFile: () => Promise<void>;
  /** Analyse a file again as mono or stereo, keeping its paint and history. */
  setFileChannelCount: (fileId: string, channelCount: number) => Promise<void>;
  synthesizeFile: (
    fileId: string,
    autoPlaybackParams?: { startTimeSeconds: number; endTimeSeconds: number } | null,
    prefetchedFboData?: Float32Array,
  ) => Promise<void>;
  /**
   * Puts a synthesis result into a file: its audio buffer, peak, onsets and
   * limiting, and either starts the stroke's playback or swaps the buffer under
   * a running one.
   */
  applySynthesizedAudio: (
    fileId: string,
    result: SynthesisAudioResult,
    options?: {
      autoPlaybackParams?: { startTimeSeconds: number; endTimeSeconds: number } | null;
      onsetStartSec?: number;
      onsetEndSec?: number;
      /** A commit's own measurements of the window it rebuilt. */
      levelWindow?: CommitLevels;
    },
  ) => Promise<AudioBuffer | null>;
  /**
   * Writes spans of kept audio into a copy of the file's buffer and installs
   * it with the readings of the state it belongs to. Any synthesis still in
   * flight described the buffer this replaces, so its result is dropped.
   */
  spliceFileAudio: (fileId: string, edits: AudioEdit[], meta: AudioStateMeta) => Promise<boolean>;
  /**
   * Derives everything a finished stroke means from one snapshot: the audio,
   * its hard edges, its limiting, its onsets and levels, and the coefficients
   * the audio analyses to. Applies the audio to the file and hands the caller
   * the result so it can write the coefficients to the canvas and to history.
   * Rejects whole — a commit that half happened would leave the three
   * disagreeing.
   */
  commitStroke: (fileId: string, snapshot: StrokeCommitSnapshot, source: CommitSource) => Promise<CommitOutcome | null>;
  loadCachedAudio: (fileId: string, audioPath: string, peak: number) => Promise<boolean>;
  restoreOnsetsForNode: (fileId: string, nodeId: string, packedData?: Float32Array) => Promise<void>;
  exportHistory: () => Promise<void>;
  exportHistoryBranch: (nodeId: string) => Promise<void>;
  exportHistoryBranchToLive: (nodeId: string) => Promise<void>;
  exportHistoryFavorites: () => Promise<void>;
  mostRecentBpm: number | null;
  setMostRecentBpm: (bpm: number) => void;
  filepathsBpm: Record<string, number>;
  setFilepathBpm: (fileId: string, bpm: number) => void;
  // Onset sensitivity is a property of the material, like its tempo: how far
  // down its own level range the hits worth keeping sit.
  filepathsOnsetSensitivity: Record<string, number>;
  setFilepathOnsetSensitivity: (filepath: string, sensitivity: number) => void;
  filesBandsPerOctave: Record<string, number>;
  setFileBandsPerOctave: (fileId: string, bandsPerOctave: number) => void;
  filesZoom: Record<string, number>;
  setFileZoom: (fileId: string, zoom: number) => void;
  filesOffset: Record<string, number>;
  setFileOffset: (fileId: string, offset: number) => void;
  /** Writes zoom and offset in one store commit. */
  setFileZoomAndOffset: (fileId: string, zoom: number, offset: number) => void;
  filesZoomY: Record<string, number>;
  setFileZoomY: (fileId: string, zoom: number) => void;
  filesOffsetY: Record<string, number>;
  setFileOffsetY: (fileId: string, offset: number) => void;
  /** Writes vertical zoom and offset in one store commit. */
  setFileZoomAndOffsetY: (fileId: string, zoom: number, offset: number) => void;
  // Maps persistable fileId → filePath (real on-disk path or `managed://<id>`
  // sentinel for files whose only on-disk backing is their history dir).
  // Serialised so the open-file list — including managed files — survives
  // app restart; reopenPersistedFiles rehydrates each entry from history.
  persistedFilePaths: Record<string, string>;
  // Persisted human-readable label per fileId. Lets a managed file's
  // "Untitled N" name (and any future user-assigned labels) survive restart
  // instead of being re-derived from iteration order.
  fileDisplayNames: Record<string, string>;
  reopenPersistedFiles: () => Promise<void>;
  recentFilePaths: string[];
  addRecentFilePath: (filePath: string) => void;
  clearRecentFilePaths: () => void;
  filesPlaybackStartTime: Record<string, number>;
  setFilePlaybackStartTime: (fileId: string, playbackStartTime: number) => void;
  // Loop region per file, in seconds. Held here rather than on the audio slice
  // so switching files carries each file's own region instead of reinterpreting
  // one file's seconds against another's buffer.
  filesLoopRegion: Record<string, LoopRegion | null>;
  setFileLoopRegion: (fileId: string, region: LoopRegion | null) => void;
  // Per-layer mix. Every file in a group sounds at the same time, so each one
  // carries its own level and its own way out of the mix.
  filesMuted: Record<string, boolean>;
  setFileMuted: (fileId: string, muted: boolean) => void;
  filesSoloed: Record<string, boolean>;
  setFileSoloed: (fileId: string, soloed: boolean) => void;
  filesVolumeDb: Record<string, number>;
  setFileVolumeDb: (fileId: string, volumeDb: number) => void;
  // Selection rectangle per file. Setting one also writes its time span to the
  // loop region, so the transport always plays what the selection covers.
  // Clearing one leaves the loop region alone.
  filesSelection: Record<string, Selection | null>;
  setFileSelection: (fileId: string, selection: Selection | null) => void;
  filesDirty: Record<string, boolean>;
  setFileDirty: (fileId: string, dirty: boolean) => void;
  filesSynthesizing: Record<string, boolean>;
  setFileSynthesizing: (fileId: string, synthesizing: boolean) => void;
  filesLoading: Record<string, string>;
  setFileLoading: (fileId: string, message: string | undefined) => void;
  /**
   * Like `filesLoading`, but the file's view stays mounted and visible: the
   * message shows in a badge over it while pointer input is held off.
   */
  filesBusy: Record<string, string>;
  activeFileId: string | null;
  setActiveFileId: (activeFileId: string | null) => Promise<void>;
  fullscreenFileId: string | null;
  setFullscreenFileId: (fileId: string | null) => void;
  minimizedFileIds: string[];
  setFileMinimized: (fileId: string, minimized: boolean) => void;
  /**
   * Settles a dragged file: before `beforeFileId` (or last when null), in
   * `stackId` (or in no group when null).
   */
  dropFile: (fileId: string, beforeFileId: string | null, stackId: string | null) => void;
  openFileMinimized: (filePath: string) => Promise<void>;
}

// Open files keyed by file ID
export const openFiles: Record<string, OpenFile> = {};
let fileEngineRegistry: FileEngineRegistry | null = null;

/** Registers the session owner for close and context teardown. */
export function attachFileEngineRegistry(registry: FileEngineRegistry): () => void {
  fileEngineRegistry = registry;
  return () => {
    if (fileEngineRegistry === registry) fileEngineRegistry = null;
    registry.dispose();
  };
}

/** Installs or clears the session-owned compatibility handle. */
export function registerFileEngineHandle(id: string, handle: FileRendererHandle | null): void {
  const file = openFiles[id];
  if (!file) return;
  file.rendererRef ??= { current: null };
  file.rendererRef.current = handle;
}

function reloadFileEngine(fileId: string): void {
  if (fileEngineRegistry?.get(fileId)) fileEngineRegistry.reload(fileId);
  else openFiles[fileId]?.rendererRef?.current?.reloadTextures();
}

// Counts synthesis requests per file, so a result that resolves after a later
// request started can tell that it has been superseded.
const fileSynthesisGeneration = new Map<string, number>();

// Resolves when the newest synthesis for a file has installed its audio.
// History navigation starts synthesis off the per-file task queue, so anything
// that reads audioBuffer alongside the current node has to wait for this.
const fileSynthesisSettled = new Map<string, Promise<void>>();

/** Waits for `fileId`'s in-flight synthesis, if one is running. */
export async function awaitFileSynthesis(fileId: string): Promise<void> {
  await fileSynthesisSettled.get(fileId);
}

/** How many audio rebuilds a file has seen; a cache keyed on it goes stale with the canvas. */
export function getFileSynthesisGeneration(fileId: string): number {
  return fileSynthesisGeneration.get(fileId) ?? 0;
}

/**
 * Merges `patch` into an open file. Returns false when the file is no longer
 * open: closing a file deletes its entry, so a write that assumes the entry is
 * there would put a closed file back into `openFiles` — holding its packed data
 * for the rest of the session with no tab to close.
 */
function updateOpenFile(fileId: string, patch: Partial<OpenFile>): boolean {
  const file = openFiles[fileId];
  if (!file) return false;
  openFiles[fileId] = { ...file, ...patch };
  return true;
}

// Walks a single sequence of brush steps and rewrites file-param entries
// whose path matches `oldPath` to `newPath`. Returns true if anything
// changed. The steps-array is the common shape of both an in-session Brush
// (Brush.steps) and an on-disk preset (PresetType.steps), so this helper
// drives both `migrateBrushRefs` (in-session) and `migrateRefsInPresetFiles`
// (preset JSONs on disk).
export function migrateRefsInSteps(
  steps: Array<{ effects?: EffectItem[] } & Record<string, unknown>>,
  oldPath: string,
  newPath: string,
): boolean {
  const fileKeys = getFileParameterKeys();
  let changed = false;
  for (const step of steps) {
    for (const key of fileKeys) {
      const def = parameterDefs[key];
      if (!def || def.kind !== "file") continue;
      if (def.effectType) {
        const effects = (step.effects ?? []) as EffectItem[];
        for (const effect of effects) {
          if (effect.effect !== def.effectType) continue;
          const val = effect.params?.[key] as FileParameterValue | undefined;
          if (val?.path === oldPath) {
            (effect.params as Record<string, FileParameterValue>)[key] = { path: newPath };
            changed = true;
          }
        }
      } else {
        const val = (step as Record<string, unknown>)[key] as FileParameterValue | undefined;
        if (val?.path === oldPath) {
          (step as Record<string, unknown>)[key] = { path: newPath };
          changed = true;
        }
      }
    }
  }
  return changed;
}

// In-session migration: walks every brush's steps. Used after Save As so
// brush references in the open editor follow a renamed file (notably the
// managed→real promotion path, where refs that pointed at `managed://<fileId>`
// get rewritten to the user-chosen filesystem path).
export function migrateBrushRefs(brushes: Brush[], oldPath: string, newPath: string): void {
  for (const brush of brushes) {
    migrateRefsInSteps(brush.steps as Array<{ effects?: EffectItem[] } & Record<string, unknown>>, oldPath, newPath);
  }
}

// On-disk migration: walks every preset .json under presetsDir. A preset's
// steps array has the same shape as a brush's, so the same per-step walker
// applies. Best-effort — a single bad file doesn't block the others, and a
// total failure (no presetsDir, permission error) just no-ops.
export async function migrateRefsInPresetFiles(presetsDir: string, oldPath: string, newPath: string): Promise<void> {
  let entries: string[];
  try {
    entries = (await host.fs.readdir(presetsDir)) as unknown as string[];
  } catch {
    return;
  }
  await Promise.all(
    entries
      .filter((f) => f.endsWith(".json"))
      .map(async (file) => {
        const filePath = host.path.join(presetsDir, file);
        try {
          const raw = (await host.fs.readFile(filePath, "utf-8")) as unknown as string;
          const preset = JSON.parse(raw) as { steps?: Array<{ effects?: EffectItem[] } & Record<string, unknown>> };
          if (!Array.isArray(preset.steps)) return;
          const changed = migrateRefsInSteps(preset.steps, oldPath, newPath);
          if (changed) {
            await host.fs.writeFile(filePath, JSON.stringify(preset, null, 2), "utf-8");
          }
        } catch (err) {
          console.error(`migrateRefsInPresetFiles: failed to process ${filePath}`, err);
        }
      }),
  );
}

// Counter for "Untitled N" labels assigned to managed files (newFile).
// Persisted indirectly: at module load it starts at 0 and reopenPersistedFiles
// pulls forward to max(N) + 1 over any rehydrated "Untitled N" names so a
// freshly-created managed file in the new session never collides with one
// from the previous session.
let untitledCounter = 0;
function nextUntitledName(): string {
  untitledCounter++;
  return `Untitled ${untitledCounter}`;
}
function bumpUntitledCounterTo(n: number): void {
  if (n > untitledCounter) untitledCounter = n;
}

// Strip a file extension from a display label so derivatives compose cleanly
// ("foo.wav" + " copy" reads as "foo copy" rather than "foo.wav copy"). Names
// without an extension (managed-file labels like "Untitled 1") pass through
// unchanged.
function stripExtensionForLabel(name: string): string {
  const ext = host.path.extname(name);
  return ext ? name.slice(0, -ext.length) : name;
}

/** Texel counts of the open files' packed textures, skipping `excludeFileId`. */
/** The packed-size fields of a spectrogram, from the band lengths the analysis returned. */
function packedSizeOf(bandLengths: Uint32Array): { texels: number; packedTextureSize: Vector2 } {
  const texels = bandLengthsTexels(bandLengths);
  return { texels, packedTextureSize: packedTextureSizeOf(texels) };
}

/** What each open file holds, for the graphics budget. */
export function openFileTexelCounts(excludeFileId?: string): OpenFileTexels[] {
  const counts: OpenFileTexels[] = [];
  for (const [id, file] of Object.entries(openFiles)) {
    if (id === excludeFileId) continue;
    const data = file.spectrogramData;
    if (!data) continue;
    const texels = data.texels;
    if (file.parked) {
      counts.push({ file: texels, canvas: 0, block: 0 });
      continue;
    }
    const grid = blockGrid({ numBands: data.numBands, metadata: data.metadata }, data.numFrames, data.sampleRate);
    const blocks = canvasWindowBlocks(grid);
    if (needsCanvasWindow(grid, blocks)) {
      const block = blockTexels(grid, 0);
      counts.push({
        file: texels,
        canvas: blocks * block,
        block,
        extraSlots: canvasExtraSlotBlocks(grid, blocks) + canvasPaintExtraSlotBlocks(grid, blocks),
      });
    } else {
      counts.push({ file: texels, canvas: texels, block: 0 });
    }
  }
  return counts;
}

/** What a fresh analysis returns, whichever host ran it. */
type AnalysisResult = {
  data: Float32Array;
  metadata: Float32Array;
  bandOffsets: Uint32Array;
  bandStepLog2s: Int32Array;
  bandLengths: Uint32Array;
  numFrames: number;
  numBands: number;
  numChannels: number;
  sampleRate: number;
  magnitudeEnergy: number;
};

/**
 * The synthesis inverse map for a file's whole layout, or nothing when the
 * canvas will hold a window: a windowed canvas builds its own from the view
 * and never samples a file-sized one, which at ten minutes is half a gigabyte.
 */
async function wholeFileInverseMap(
  layout: BandLayout,
  numFrames: number,
  sampleRate: number,
  synthesis: { bandOffsets: Uint32Array; bandStepLog2s: Int32Array; bandLengths: Uint32Array },
  texels: number,
): Promise<Float32Array | undefined> {
  const grid = blockGrid(layout, numFrames, sampleRate);
  if (needsCanvasWindow(grid, canvasWindowBlocks(grid))) return undefined;
  return await host.analysis.buildHistoryInverseMap(
    new Uint32Array(synthesis.bandOffsets),
    new Uint32Array(synthesis.bandLengths),
    new Int32Array(synthesis.bandStepLog2s),
    texels,
  );
}

/**
 * Rebuilds the whole file's audio from the store, a chunk of coefficients at a
 * time. With `onsets`, each chunk's detection curves are found from the same
 * read while the chunk is synthesised, and come back with the audio.
 */
async function synthesiseFromSpans(
  read: (ranges: Uint32Array) => Promise<Float32Array | null>,
  layout: PackedLayout,
  sampleRate: number,
  params: AnalysisParams,
  onsets?: ChunkOnsetPass,
) {
  const pass: SynthesiseView = (packed, meta, existingAudio, startFrame, endFrame) =>
    host.analysis.synthesize(
      packed,
      meta,
      sampleRate,
      { ...params, fullSynthesisSupport: true },
      false,
      existingAudio,
      startFrame,
      endFrame,
      0,
      layout.numBands,
    );
  const readReach = await host.analysis.synthesisReadReach(sampleRate, params);
  return synthesiseInChunks(pass, spanReader(read), layout, sampleRate, readReach, SYNTHESIS_CHUNK_SECONDS, onsets);
}

/** True while the file's onsets were judged against a gate a pass over the whole file arrived at. */
function hasOnsetGate(file: Pick<OpenFile, "onsets" | "onsetReference">): boolean {
  return file.onsets !== undefined && file.onsetReference !== undefined && file.onsetReference.odfMax > 0;
}

/**
 * The onset pass a chunked synthesis runs alongside itself, or null when the
 * host cannot fold the two, or the file's band maxima are unknown.
 */
function chunkOnsetPass(
  layout: PackedLayout,
  sampleRate: number,
  bandMax: Float32Array | undefined,
): ChunkOnsetPass | null {
  const curves = host.analysis.onsetCurvesOfChunk;
  if (!curves || !bandMax || bandMax.length < layout.numBands) return null;
  return {
    curves: (packed, view, startFrame, endFrame) =>
      curves(packed, layout, sampleRate, bandMax, view, startFrame, endFrame),
  };
}

/** A range reader that refuses rather than answering with a gap. */
/**
 * Rebuilds frames [startFrame, endFrame) of bands [startBand, endBand) from a
 * view of the store around them and splices them into `existing`, as a whole
 * run's partial synthesis does.
 */
async function synthesiseRegionFromSpans(
  read: (ranges: Uint32Array) => Promise<Float32Array | null>,
  layout: PackedLayout,
  sampleRate: number,
  params: AnalysisParams,
  existing: Float32Array[],
  region: { startFrame: number; endFrame: number; startBand: number; endBand: number },
) {
  const reach = await host.analysis.synthesisReadReach(sampleRate, params);
  const view = synthesisViewOf(layout, sampleRate, reach, region.startFrame, region.endFrame);
  return host.analysis.synthesize(
    await spanReader(read)(view.ranges),
    view.meta,
    sampleRate,
    params,
    false,
    existing,
    region.startFrame,
    region.endFrame,
    region.startBand,
    region.endBand,
  );
}

function spanReader(read: (ranges: Uint32Array) => Promise<Float32Array | null>) {
  return async (ranges: Uint32Array): Promise<Float32Array> => {
    const values = await read(ranges);
    if (!values) throw new Error("the store could not serve the painted state");
    return values;
  };
}

/**
 * The onsets a chunked synthesis owes, read from the store rather than from a
 * run of the file. Null when the host answers whole passes only. A pass with
 * no reference to judge a span by covers the file and works one out, which is
 * what a whole-file pass would have done.
 */
async function scanOnsetsFromSpans(
  read: (ranges: Uint32Array) => Promise<Float32Array | null>,
  layout: PackedLayout,
  sampleRate: number,
  file: OpenFile,
  params: AnalysisParams,
): Promise<{ onsets: PackedOnsets; onsetOdfMax: number; onsetBandMax: Float32Array } | null> {
  const scan = host.analysis.scanFileOnsets;
  if (!scan) return null;
  const reference = file.onsetReference;
  const region =
    reference && reference.odfMax > 0 && params.onsetStartSec !== undefined && params.onsetEndSec !== undefined
      ? { startSec: params.onsetStartSec, endSec: params.onsetEndSec, odfReference: reference.odfMax }
      : undefined;
  const bandMax = reference?.bandMax ?? new Float32Array(0);
  const found = await scan(spanReader(read), layout, sampleRate, bandMax, region);
  return { onsets: found.onsets, onsetOdfMax: found.odfMax, onsetBandMax: found.bandMax };
}

/** What an analysis leaves behind, however it was run. */
type AnalysedFile = {
  spectrogramData: SpectrogramData;
  onsets: PackedOnsets;
  onsetReference: { odfMax: number; bandMax: Float32Array };
};

/**
 * Analyses a file a block at a time, writing each block into the file's store
 * as it lands, so the coefficients of the whole file are never held. A file
 * the canvas can hold whole keeps its run all the same: everything downstream
 * of a short file still works on one, and a short file's run is cheap.
 */
async function analyseIntoBlocks(
  fileId: string,
  filePath: string,
  params: AnalysisParams,
  openStream: NonNullable<typeof host.analysis.openAnalysisStream>,
): Promise<AnalysedFile> {
  const openStart = performance.now();
  const stream = await openStream(filePath, params);
  const decodeMs = performance.now() - openStart;
  const shape = stream.layout;
  const layout = bandLayoutOf(
    shape.numBands,
    shape.bandOffsets,
    shape.bandLengths,
    shape.bandStepLog2s,
    shape.bandFreqsHz,
  );
  const size = packedSizeOf(shape.bandLengths);
  const grid = blockGrid(layout, shape.numFrames, shape.sampleRate);
  const windowed = needsCanvasWindow(grid, canvasWindowBlocks(grid));
  const store = await openBlockStore(fileId, layout, {
    numFrames: shape.numFrames,
    sampleRate: shape.sampleRate,
    texelCount: size.texels,
  });

  const whole = windowed ? null : new Float32Array(size.texels * 4);
  const strip = windowed ? new CoarseStripBuilder(layout, coarseStripLevel(layout)) : null;
  const spansStart = performance.now();
  await store.seedFrom(async (index) => {
    const { start, end } = frameRangeOfBlock(grid, index);
    const block = await stream.span(start, end);
    if (whole) scatterCompactPixelRanges(whole, block, store.blockRanges(index));
    strip?.add(store.blockRanges(index), block);
    return block;
  });
  const summary = stream.summary();
  const spansMs = performance.now() - spansStart;

  const packedLayout: PackedLayout = {
    numFrames: shape.numFrames,
    numChannels: shape.numChannels,
    numBands: shape.numBands,
    bandOffsets: shape.bandOffsets,
    bandStepLog2s: shape.bandStepLog2s,
    bandLengths: shape.bandLengths,
  };
  // A windowed file's first synthesis reads every block again, and finds the
  // onsets from that read; the analysis leaves it the band maxima and no gate.
  const scan = host.analysis.scanFileOnsets;
  const alongside = !whole && host.analysis.onsetCurvesOfChunk && host.analysis.finishFileOnsets;
  const detected = alongside
    ? { onsets: new Float32Array(0), odfMax: 0, bandMax: summary.onsetBandMax }
    : whole || !scan
      ? await host.analysis.detectOnsets(whole ?? (await store.readAll()), packedLayout, shape.sampleRate)
      : await scan((ranges) => store.readRanges(ranges), packedLayout, shape.sampleRate, summary.onsetBandMax);
  diag.timing("file", "open phases", performance.now() - openStart, {
    decode: Math.round(decodeMs),
    spans: Math.round(spansMs),
    onsets: Math.round(performance.now() - spansStart - spansMs),
  });

  return {
    spectrogramData: {
      packedData: whole ?? undefined,
      coarseStrip: strip?.strip(),
      inverseMap: await wholeFileInverseMap(layout, shape.numFrames, shape.sampleRate, packedLayout, size.texels),
      metadata: layout.metadata,
      ...size,
      numFrames: shape.numFrames,
      numBands: shape.numBands,
      numChannels: shape.numChannels,
      sampleRate: shape.sampleRate,
      minFreq: params.minFreq,
      bandsPerOctave: params.bandsPerOctave,
      magnitudeEnergy: summary.magnitudeEnergy,
      synthesisMetadata: {
        bandOffsets: shape.bandOffsets,
        bandStepLog2s: shape.bandStepLog2s,
        bandLengths: shape.bandLengths,
      },
    },
    onsets: detected.onsets,
    onsetReference: { odfMax: detected.odfMax, bandMax: detected.bandMax },
  };
}

/**
 * A file's current painted state, by pixel range. The block store serves it
 * where it holds that state; otherwise one run of the whole file is read and
 * gathered from, which is what a host with no block state has to do.
 */
async function currentStateRanges(file: OpenFile): Promise<(ranges: Uint32Array) => Promise<Float32Array>> {
  const manager = getHistoryManager(file.id);
  await manager.awaitPackedReaders();
  if ((await manager.currentRanges(new Uint32Array())) !== null) {
    let fallback: Float32Array | null = null;
    return async (ranges) => {
      if (fallback) return gatherPixelRanges(fallback, ranges);
      const values = await manager.currentRanges(ranges);
      if (values) return values;
      console.warn("Block store unreadable, falling back to full painted state");
      fallback = (await readCurrentPackedData(file)) ?? null;
      if (!fallback) throw new Error("could not read the file's painted state");
      return gatherPixelRanges(fallback, ranges);
    };
  }
  const whole = await readCurrentPackedData(file);
  if (!whole) throw new Error("could not read the file's painted state");
  return async (ranges) => gatherPixelRanges(whole, ranges);
}

/**
 * Seeds `toFileId`'s block store a block at a time, so no file's run is ever
 * held. `blockOf` turns the block's pixel ranges into the values to write —
 * one file's state, or several files summed. Returns the whole run only when
 * the canvas can hold it: everything downstream of a short file works on one.
 */
async function seedFileBlocks(
  toFileId: string,
  spec: SpectrogramData,
  blockOf: (grid: BlockGrid, index: number, ranges: Uint32Array) => Promise<Float32Array>,
): Promise<Float32Array | undefined> {
  const layout = { numBands: spec.numBands, metadata: spec.metadata };
  const grid = blockGrid(layout, spec.numFrames, spec.sampleRate);
  const store = await openBlockStore(toFileId, layout, {
    numFrames: spec.numFrames,
    sampleRate: spec.sampleRate,
    texelCount: spec.texels,
  });
  const whole = needsCanvasWindow(grid, canvasWindowBlocks(grid)) ? null : new Float32Array(spec.texels * 4);
  await store.seedFrom(async (index) => {
    const ranges = store.blockRanges(index);
    const values = await blockOf(grid, index, ranges);
    if (whole) scatterCompactPixelRanges(whole, values, ranges);
    return values;
  });
  return whole ?? undefined;
}

/** Seeds `toFileId`'s store from another file's current painted state. */
async function copyStateIntoBlocks(
  from: OpenFile,
  toFileId: string,
  spec: SpectrogramData,
): Promise<Float32Array | undefined> {
  const read = await currentStateRanges(from);
  return await serializeFileTask(from.id, () =>
    seedFileBlocks(toFileId, spec, (_grid, _index, ranges) => read(ranges)),
  );
}

/**
 * Seeds `toFileId`'s store with the files' coefficients summed. The sum is
 * per texel, so a block of the sum is the sum of that block.
 */
async function mergeStatesIntoBlocks(
  files: OpenFile[],
  toFileId: string,
  spec: SpectrogramData,
): Promise<Float32Array | undefined> {
  const readers = await Promise.all(files.map((file) => currentStateRanges(file)));
  const sortedIds = [...new Set(files.map((file) => file.id))].sort();
  const runSeed = (): Promise<Float32Array | undefined> =>
    seedFileBlocks(toFileId, spec, async (grid, index, ranges) => {
      const parts: Float32Array[] = [];
      for (const read of readers) parts.push(await read(ranges));
      const { merged } = await host.analysis.mergeSpectrograms(parts, {
        ...blockBandLayout(grid, index),
        numChannels: spec.numChannels,
      });
      return merged;
    });
  return await sortedIds.reduceRight((next, fileId) => () => serializeFileTask(fileId, next), runSeed)();
}

/**
 * A fresh analysis as the state the renderer paints on. The analysis returns
 * coefficients alone, so the inverse map is built here.
 */
export async function spectrogramFromAnalysis(
  result: AnalysisResult,
  opts: { minFreq: number; bandsPerOctave: number },
): Promise<SpectrogramData & { packedData: Float32Array }> {
  const rows = new Float32Array(result.metadata.buffer, result.metadata.byteOffset, result.metadata.byteLength / 4);
  const freqs = new Float64Array(result.numBands);
  for (let band = 0; band < result.numBands; band++) freqs[band] = rows[band * 4 + 3];
  // Built from the exact per-band arrays, not from the metadata rows: those
  // are floats for the texture, and a float cannot count a long file's
  // coefficients one by one.
  const layout = bandLayoutOf(result.numBands, result.bandOffsets, result.bandLengths, result.bandStepLog2s, freqs);
  const size = packedSizeOf(result.bandLengths);
  const inverseMap = await wholeFileInverseMap(layout, result.numFrames, result.sampleRate, result, size.texels);
  return {
    packedData: new Float32Array(result.data.buffer, result.data.byteOffset, result.data.byteLength / 4),
    inverseMap,
    metadata: layout.metadata,
    ...size,
    numFrames: result.numFrames,
    numBands: result.numBands,
    numChannels: result.numChannels,
    sampleRate: result.sampleRate,
    minFreq: opts.minFreq,
    bandsPerOctave: opts.bandsPerOctave,
    magnitudeEnergy: result.magnitudeEnergy,
    synthesisMetadata: {
      bandOffsets: result.bandOffsets,
      bandStepLog2s: result.bandStepLog2s,
      bandLengths: result.bandLengths,
    },
  };
}

/** Logs a file's spectrogram footprint and the share of the graphics budget all open files now hold. */
export function logFileFootprint(fileId: string, event: string, extra?: Record<string, unknown>): void {
  const file = openFiles[fileId];
  const data = file?.spectrogramData;
  if (!file || !data) return;
  diag.info("file", event, {
    name: host.path.basename(file.filePath),
    seconds: Math.round((data.numFrames / data.sampleRate) * 10) / 10,
    sampleRate: data.sampleRate,
    channels: data.numChannels,
    bandsPerOctave: data.bandsPerOctave,
    texels: data.texels,
    windowBlocks: canvasWindowBlocks(
      blockGrid({ numBands: data.numBands, metadata: data.metadata }, data.numFrames, data.sampleRate),
    ),
    openFiles: Object.keys(openFiles).length,
    budgetPercent: Math.round((usedBudgetFraction(openFileTexelCounts()) ?? 0) * 100),
    ...extra,
  });
}

// Run gaborator analysis on a real on-disk wav and stash the resulting
// SpectrogramData on the file. Used by first-time-open and as a recovery
// fallback in reopenPersistedFiles when a real file's history dir is missing.
// Returns false when the file closed before the analysis finished, which
// discards the result.
async function loadRealFileViaGaborator(
  fileId: string,
  filePath: string,
  bandsPerOctave: number,
  minFreq: number,
): Promise<boolean> {
  const file = openFiles[fileId];
  if (!file) return false;
  const diskPath = isBundledPath(filePath) ? resolveBundledPath(filePath) : filePath;
  const otherTexelCounts = openFileTexelCounts(fileId);
  const analysisStart = performance.now();
  const params: AnalysisParams = {
    bandsPerOctave,
    minFreq,
    maxCoefficients: remainingCoefficientBudget(otherTexelCounts),
  };
  const openStream = host.analysis.openAnalysisStream;
  let analysed: AnalysedFile;
  try {
    if (openStream) {
      analysed = await analyseIntoBlocks(fileId, diskPath, params, openStream);
    } else {
      const result = await host.analysis.analyze(diskPath, params);
      analysed = {
        spectrogramData: await spectrogramFromAnalysis(result, { minFreq, bandsPerOctave }),
        onsets: result.onsets,
        onsetReference: { odfMax: result.onsetOdfMax ?? 0, bandMax: result.onsetBandMax ?? new Float32Array() },
      };
    }
  } catch (error) {
    diag.error("file", "analysis failed", { name: host.path.basename(filePath), bandsPerOctave, error });
    if (error instanceof Error && error.message.includes("maximum audio duration") && otherTexelCounts.length > 0) {
      throw new Error(`${error.message} Close another file to free graphics memory.`);
    }
    throw error;
  }
  const analysisMs = performance.now() - analysisStart;
  diag.timing("file", "analysis", analysisMs, { name: host.path.basename(filePath), bandsPerOctave });
  return updateOpenFile(fileId, {
    spectrogramData: analysed.spectrogramData,
    onsets: analysed.onsets,
    onsetReference: analysed.onsetReference.bandMax.length > 0 ? analysed.onsetReference : undefined,
  });
}

// In-flight AI separation guard — blocks a second concurrent stem split on the same file.
const aiSeparatingFileIds = new Set<string>();

/** Stable 0-359 hue for a string, for anything without a hue of its own. */
export function hashHue(value: string): number {
  let hash = 0;
  for (let i = 0; i < value.length; i++) {
    hash = value.charCodeAt(i) + ((hash << 5) - hash);
  }
  return ((hash % 360) + 360) % 360;
}

// Hue per open file path. Entries for closed files are released so their hue
// can go to a later file.
const fileHues = new Map<string, number>();

const FIRST_FILE_HUE = 210;

/** The hue furthest from every hue in `taken`: the midpoint of the widest gap on the wheel. */
function farthestHue(taken: number[]): number {
  if (taken.length === 0) return FIRST_FILE_HUE;
  const sorted = [...taken].sort((a, b) => a - b);
  let widestStart = sorted[0];
  let widest = 0;
  for (let i = 0; i < sorted.length; i++) {
    const start = sorted[i];
    const end = i + 1 < sorted.length ? sorted[i + 1] : sorted[0] + 360;
    if (end - start > widest) {
      widest = end - start;
      widestStart = start;
    }
  }
  return (widestStart + widest / 2) % 360;
}

// Release the hues of files that have closed, then give every open file without
// one the hue furthest from the hues in use.
function syncFileHues(): void {
  const openPaths = new Set(Object.values(openFiles).map((f) => f.filePath));
  for (const path of fileHues.keys()) {
    if (!openPaths.has(path)) fileHues.delete(path);
  }
  for (const file of Object.values(openFiles)) {
    if (!fileHues.has(file.filePath)) fileHues.set(file.filePath, farthestHue([...fileHues.values()]));
  }
}

/** Hue of an open file, or a hash of the path for a file that is not open. */
export function getFileHue(filePath: string): number {
  syncFileHues();
  return fileHues.get(filePath) ?? hashHue(filePath);
}

/** Get the colour of a file. Every open file gets its own. */
export function getFileColor(filePath: string): string {
  return `hsl(${getFileHue(filePath)}, 60%, 60%)`;
}

/** The colour a file wears everywhere: a shade of its group's hue if it is a stem, else its own. */
export function selectFileColor(state: Pick<State, "layerStacks" | "stackOfLayer">, fileId: string): string {
  const group = selectLayerStack(state, fileId);
  if (group) return layerColor(group.hue, group.layerIds.indexOf(fileId), group.layerIds.length);
  const file = openFiles[fileId];
  return getFileColor(file?.filePath ?? fileId);
}

/** Look up an open file by its file path. Returns the first match or undefined. */
export function getOpenFileByPath(filePath: string): OpenFile | undefined {
  return Object.values(openFiles).find((f) => f.filePath === filePath);
}

/** A single reference from a brush step (or effect within a step) to an open file. */
export type FileReference = {
  brushIndex: number;
  brushName: string;
  paramKey: ParameterKey;
  paramLabel: string;
};

function forEachFileValue(
  brushes: Brush[],
  visit: (ref: {
    brushIndex: number;
    brushName: string;
    paramKey: ParameterKey;
    value: FileParameterValue;
    clear: () => void;
  }) => void,
) {
  const fileKeys = getFileParameterKeys();
  brushes.forEach((brush, brushIndex) => {
    for (const step of brush.steps) {
      for (const key of fileKeys) {
        const def = parameterDefs[key];
        if (!def || def.kind !== "file") continue;
        if (def.effectType) {
          const effects = (step.effects ?? []) as EffectItem[];
          for (const effect of effects) {
            if (effect.effect !== def.effectType) continue;
            const val = effect.params?.[key] as FileParameterValue | undefined;
            const clear = () => {
              if (effect.params) delete effect.params[key];
            };
            if (val) visit({ brushIndex, brushName: brush.name, paramKey: key, value: val, clear });
          }
        } else {
          const val = (step as Record<string, unknown>)[key] as FileParameterValue | undefined;
          const clear = () => {
            (step as Record<string, unknown>)[key] = null;
          };
          if (val) visit({ brushIndex, brushName: brush.name, paramKey: key, value: val, clear });
        }
      }
    }
  });
}

/** Find every place a file path is referenced across all brushes (step sources + effect file params). */
export function findFileReferences(filePath: string, brushes: Brush[]): FileReference[] {
  const results: FileReference[] = [];
  forEachFileValue(brushes, ({ brushIndex, brushName, paramKey, value }) => {
    if (value?.path === filePath) {
      const def = parameterDefs[paramKey];
      if (def) results.push({ brushIndex, brushName, paramKey, paramLabel: def.label });
    }
  });
  return results;
}

/** Check if a file is referenced by any brush (as source or as an effect file param). */
export function isFileReferenced(filePath: string, brushes: Brush[]): boolean {
  return findFileReferences(filePath, brushes).length > 0;
}

/**
 * Unset every brush reference to `filePath`, in both step sources and effect
 * file params. `brushes` is mutated, so pass an immer draft.
 */
export function clearFileReferences(filePath: string, brushes: Brush[]): void {
  forEachFileValue(brushes, ({ value, clear }) => {
    if (value?.path === filePath) clear();
  });
}

/** Open each path minimized, warning about the ones no longer on disk. */
export function openReferencedPaths(paths: string[], get: ZustandGet) {
  for (const path of paths) {
    get()
      .openFileMinimized(path)
      .catch(() => {
        notifications.show({
          title: "Referenced file not found",
          message: `${path.split("/").pop()} not found on disk`,
          color: "yellow",
        });
      });
  }
}

/** Collect every distinct file path referenced by a single brush (for bulk load). */
export function collectBrushReferencedPaths(brush: Brush): string[] {
  const paths = new Set<string>();
  forEachFileValue([brush], ({ value }) => {
    if (value?.path) paths.add(value.path);
  });
  return [...paths];
}

// Helper to get file by ID
export function getFileById(fileId: string): OpenFile | undefined {
  return openFiles[fileId];
}

// Helper to find file ID by path
export function getFileIdByPath(filePath: string): string | undefined {
  return Object.keys(openFiles).find((id) => openFiles[id].filePath === filePath);
}

// ─── Stem splitting ──────────────────────────────────────────────────────────

/**
 * Derive a child spectrogram from the file it came from: same grid, same
 * metadata, new coefficients. The small typed arrays are copied so editing the
 * child never writes through to its source; the file-sized inverse map is
 * shared, because nothing writes it — a re-analysis builds a fresh one.
 */
export async function deriveSpectrogramData(
  base: SpectrogramData,
  packedData?: Float32Array,
): Promise<SpectrogramData> {
  const inverseMap =
    base.inverseMap ??
    (await wholeFileInverseMap(base, base.numFrames, base.sampleRate, base.synthesisMetadata, base.texels));
  return {
    ...base,
    packedData,
    inverseMap,
    metadata: base.metadata.slice(),
    synthesisMetadata: {
      bandLengths: base.synthesisMetadata.bandLengths.slice(),
      bandOffsets: base.synthesisMetadata.bandOffsets.slice(),
      bandStepLog2s: base.synthesisMetadata.bandStepLog2s.slice(),
    },
  };
}

// The metadata shape the coefficient-domain addon entry points (hpss, nmf,
// mergeSpectrograms) expect.
function bandLayout(data: SpectrogramData) {
  return {
    numBands: data.numBands,
    numChannels: data.numChannels,
    bandOffsets: data.synthesisMetadata.bandOffsets,
    bandLengths: data.synthesisMetadata.bandLengths,
  };
}

// The metadata shape the synthesis entry points expect.
function synthesisLayout(data: SpectrogramData) {
  return {
    numFrames: data.numFrames,
    numChannels: data.numChannels,
    numBands: data.numBands,
    bandOffsets: data.synthesisMetadata.bandOffsets,
    bandStepLog2s: data.synthesisMetadata.bandStepLog2s,
    bandLengths: data.synthesisMetadata.bandLengths,
  };
}

/**
 * A file's sound as its canvas currently holds it, synthesised from the store
 * a chunk of coefficients at a time so the run of the whole file is never
 * held. A host that answers whole passes only takes the run.
 */
async function currentFileAudio(file: OpenFile): Promise<Float32Array[] | null> {
  const spec = file.spectrogramData;
  if (!spec) return null;
  const params: AnalysisParams = { bandsPerOctave: spec.bandsPerOctave, minFreq: spec.minFreq };
  const layout = synthesisLayout(spec);
  if (host.analysis.openAnalysisStream) {
    const read = await currentStateRanges(file);
    return (await synthesiseFromSpans(read, layout, spec.sampleRate, params)).channels;
  }
  const whole = await readCurrentPackedData(file);
  if (!whole) return null;
  return (await host.analysis.synthesize(whole, layout, spec.sampleRate, params, false)).channels;
}

/** A file's audio as it currently sounds, synthesising it when it has no buffer. */
export async function currentFileChannels(
  fileId: string,
): Promise<{ channels: Float32Array[]; sampleRate: number } | null> {
  const snapshot = await snapshotFileAudio(fileId);
  if (snapshot) return { channels: snapshot.channels, sampleRate: snapshot.sampleRate };

  const file = openFiles[fileId];
  const spectrogramData = file?.spectrogramData;
  if (!file || !spectrogramData) return null;
  const channels = await currentFileAudio(file);
  return channels ? { channels, sampleRate: spectrogramData.sampleRate } : null;
}

/**
 * Sums the files' audio and analyses the result, for files whose grids do not
 * line up. Everything is resampled to the highest rate among them and the mix
 * runs as long as the longest, so files of any length or rate still add up.
 * `base` sets the resolution the sum is analysed at.
 */
async function mixFilesDown(fileIds: string[], base: SpectrogramData): Promise<SpectrogramData> {
  const sources = await Promise.all(fileIds.map((id) => currentFileChannels(id)));
  const parts = sources.filter((source): source is NonNullable<(typeof sources)[number]> => source !== null);
  if (parts.length !== fileIds.length) throw new Error("Could not read the current audio of every file");

  const sampleRate = Math.max(...parts.map((part) => part.sampleRate));
  const resampled = await Promise.all(
    parts.map((part) => resampleChannels(part.channels, part.sampleRate, sampleRate)),
  );
  const channels = mixdown(resampled);
  if (channels.length === 0 || channels[0].length === 0) throw new Error("There is no audio to merge.");

  const analysisParams: AnalysisParams = {
    bandsPerOctave: base.bandsPerOctave,
    minFreq: base.minFreq,
    maxCoefficients: remainingCoefficientBudget(openFileTexelCounts()),
  };
  const audioBuffer = Tone.getContext().rawContext.createBuffer(channels.length, channels[0].length, sampleRate);
  for (let ch = 0; ch < channels.length; ch++) audioBuffer.getChannelData(ch).set(channels[ch]);

  return await spectrogramFromAnalysis(await host.analysis.analyseBuffer(audioBuffer, analysisParams), analysisParams);
}

/**
 * Rebuild a file from the audio it already plays, with `transform` rewriting
 * the channels. The audio buffer is the synthesis of the canvas — every commit
 * and navigation keeps it so — which makes it a starting point that needs no
 * resynthesis and no FBO read. A file with no buffer yet takes the synthesis
 * road instead. Replaces the file's spectrogram, audio and peak, and adds the
 * result to its history; the renderer is optional throughout.
 */
/**
 * A splice length rounded to the analysis splice grid (~1.5 ms), so the tail
 * rigid-moves in the splice analysis. A length that rounds to nothing comes
 * back unrounded: the edit stays exact and takes the slow road.
 */
export function quantizeSpliceLength(samples: number, sampleRate: number): number {
  const quant = host.analysis.spliceQuantSamples?.(sampleRate) ?? 1;
  const rounded = Math.round(samples / quant) * quant;
  return rounded > 0 ? rounded : Math.round(samples);
}

/** Onsets a caller already knows for the rebuilt file, in place of detection. */
export type PrecomputedOnsets = {
  onsets: Float32Array;
  reference: { odfMax: number; bandMax: Float32Array } | undefined;
};

export async function rebuildFileFromCurrentAudio(
  set: ZustandSet,
  fileId: string,
  transform: (channels: Float32Array[]) => Float32Array[],
  snapshot: { kind: "resize" | "reanalyze"; label: string },
  onVisible?: () => void,
  precomputedOnsets?: PrecomputedOnsets,
  pieces?: (oldFrames: number) => SplicePiece[],
): Promise<void> {
  return serializeFileTask(fileId, async () => {
    // Navigation moves the current node and then starts synthesis off the
    // queue, so the buffer is the current state only once that has landed.
    await awaitFileSynthesis(fileId);
    const file = openFiles[fileId];
    if (!file?.spectrogramData) return;
    const buffer = file.audioBuffer;
    if (!buffer) {
      await rebuildFileFromAudioNow(set, fileId, transform, snapshot, onVisible);
      return;
    }
    const channels: Float32Array[] = [];
    for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
      channels.push(buffer.getChannelData(ch));
    }
    await rebuildFileWithChannels(set, fileId, transform(channels), snapshot, onVisible, precomputedOnsets, pieces);
  });
}

async function rebuildFileFromAudioNow(
  set: ZustandSet,
  fileId: string,
  transform: (channels: Float32Array[]) => Float32Array[],
  snapshot: { kind: "resize" | "reanalyze"; label: string },
  onVisible?: () => void,
): Promise<void> {
  const file = openFiles[fileId];
  if (!file?.spectrogramData) return;

  const channels = await currentFileAudio(file);
  if (!channels) throw new Error("Could not read the current spectrogram state.");
  if (!openFiles[fileId]) return;

  await rebuildFileWithChannels(set, fileId, transform(channels), snapshot, onVisible);
}

/**
 * The tail every rebuild shares: analyse `channels`, swap the file's
 * spectrogram, audio, peak and onsets, and add the result to its history.
 * `onVisible` fires once the new state is on screen and interactive; the
 * history snapshot is written after it, still inside the caller's queue slot,
 * so anything queued behind — another edit, an undo — waits for the node.
 */
async function rebuildFileWithChannels(
  set: ZustandSet,
  fileId: string,
  channels: Float32Array[],
  snapshot: { kind: "resize" | "reanalyze"; label: string },
  onVisible?: () => void,
  precomputedOnsets?: PrecomputedOnsets,
  pieces?: (oldFrames: number) => SplicePiece[],
): Promise<void> {
  const file = openFiles[fileId];
  if (!file?.spectrogramData) return;

  const { spectrogramData } = file;
  const analysisParams: AnalysisParams = {
    bandsPerOctave: spectrogramData.bandsPerOctave,
    minFreq: spectrogramData.minFreq,
    maxCoefficients: remainingCoefficientBudget(openFileTexelCounts(fileId)),
    ...(precomputedOnsets ? { detectOnsets: false } : {}),
  };

  const length = channels[0]?.length ?? 0;
  if (length <= 0) throw new Error("There is no audio left to analyse.");

  const audioContext = Tone.getContext().rawContext;
  const audioBuffer = audioContext.createBuffer(channels.length, length, spectrogramData.sampleRate);
  for (let ch = 0; ch < channels.length; ch++) {
    audioBuffer.getChannelData(ch).set(channels[ch]);
  }

  // A splice-shaped rebuild reuses the old coefficients wherever the pieces
  // say the audio is unchanged; anything that cannot splice takes the full
  // analysis road below.
  let result: Awaited<ReturnType<typeof host.analysis.analyseBuffer>> | undefined;
  const splices = Boolean(pieces && precomputedOnsets && host.analysis.spliceAnalyseChannels);
  // The unchanged ranges copy across as they stand now, paint and all, so the
  // splice reads the painted state rather than the coefficients analysis left.
  const oldPacked = splices ? await readCurrentPackedData(file) : undefined;
  if (pieces && oldPacked && host.analysis.spliceAnalyseChannels) {
    try {
      result = await host.analysis.spliceAnalyseChannels(
        channels,
        spectrogramData.sampleRate,
        analysisParams,
        oldPacked,
        synthesisLayout(spectrogramData),
        pieces(spectrogramData.numFrames),
      );
    } catch (error) {
      console.warn("Splice analysis fell back to a full analysis:", error);
    }
  }
  if (!result) result = await host.analysis.analyseBuffer(audioBuffer, analysisParams);

  if (!openFiles[fileId]) return;

  file.spectrogramData = await spectrogramFromAnalysis(result, analysisParams);
  file.audioBuffer = audioBuffer;
  file.unprojectedPaint = false;
  // The rebuild moves every frame, so the onsets come from the caller when it
  // knows how they moved, else from the detection this analysis ran.
  file.onsets = precomputedOnsets ? precomputedOnsets.onsets : result.onsets;
  file.onsetReference = precomputedOnsets
    ? precomputedOnsets.reference
    : result.onsetOdfMax !== undefined && result.onsetBandMax
      ? { odfMax: result.onsetOdfMax, bandMax: result.onsetBandMax }
      : undefined;

  let newPeak = 0;
  for (let ch = 0; ch < audioBuffer.numberOfChannels; ch++) {
    const data = audioBuffer.getChannelData(ch);
    for (let i = 0; i < data.length; i++) {
      const v = Math.abs(data[i]);
      if (v > newPeak) newPeak = v;
    }
  }
  file.audioPeak = newPeak > 0 ? newPeak : 1;

  reloadFileEngine(fileId);

  const reshaped = file.spectrogramData.packedData;
  if (!reshaped) throw new Error("the snapshot result carries no packed state");

  const newDuration = length / spectrogramData.sampleRate;
  set(
    produce((state: State) => {
      state.filesDirty[fileId] = true;
      // The rebuild moves every frame, so a selection, loop region or play
      // marker measured against the old length no longer points at what it
      // covered — and a loop end past the new duration cannot start playback.
      state.filesSelection[fileId] = null;
      const marker = state.filesPlaybackStartTime[fileId];
      if (marker !== undefined && marker > newDuration) {
        state.filesPlaybackStartTime[fileId] = newDuration;
      }
      const region = state.filesLoopRegion[fileId];
      if (region) {
        if (region.start >= newDuration) {
          state.filesLoopRegion[fileId] = null;
        } else if (region.end > newDuration) {
          state.filesLoopRegion[fileId] = { ...region, end: newDuration };
        }
      }
    }),
  );
  onVisible?.();

  const nodeId = await getHistoryManager(fileId).addSnapshot({
    data: reshaped,
    kind: snapshot.kind,
    label: snapshot.label,
    spectrogram: file.spectrogramData,
  });
  file.rendererRef?.current?.releaseAnalysisData();

  if (file.onsets && file.onsetReference) {
    await getHistoryManager(fileId).setNodeOnsets(
      nodeId,
      packOnsetState({ onsets: file.onsets, reference: file.onsetReference }),
    );
  }
}

// The current painted state of a file. Without a mounted renderer to read an
// FBO from, the block store's current tier serves it, and a transient rebuild
// from the on-disk history is the last resort.
export async function readCurrentPackedData(file: OpenFile): Promise<Float32Array | undefined> {
  const manager = getHistoryManager(file.id);
  const blocks = await manager.currentBlockState();
  if (blocks) return blocks;
  if (file.spectrogramData?.packedData) return file.spectrogramData.packedData;
  const currentId = manager.getCurrentId();
  if (!currentId) return undefined;
  try {
    return (await manager.reconstruct(currentId)).packedData;
  } catch {
    return undefined;
  }
}

type FileAudioSnapshot = { nodeId: string | null; channels: Float32Array[]; sampleRate: number };

/**
 * Take `fileId`'s audio channels and the history node they came from together,
 * queued behind any stroke commit or history navigation still deriving them.
 */
async function snapshotFileAudio(fileId: string): Promise<FileAudioSnapshot | null> {
  return serializeFileTask(fileId, async () => {
    // Navigation moves the current node and then starts synthesis off the queue,
    // so the buffer only belongs to that node once the synthesis has landed.
    await awaitFileSynthesis(fileId);
    const current = openFiles[fileId];
    if (!current?.audioBuffer) return null;
    const nodeId = await getHistoryManager(fileId).currentNodeId();
    const channels: Float32Array[] = [];
    for (let i = 0; i < current.audioBuffer.numberOfChannels; i++) {
      channels.push(new Float32Array(current.audioBuffer.getChannelData(i)));
    }
    return { nodeId, channels, sampleRate: current.audioBuffer.sampleRate };
  });
}

// Insert placeholder files for a pending split directly after their source so
// they appear with a spinner while the separator runs. The caller fills in each
// file's spectrogramData when it returns, or calls discardFiles on failure.
function createStemPlaceholders(
  set: ZustandSet,
  get: ZustandGet,
  sourceFileId: string,
  labels: string[],
  loadingMessage: string,
  baseName?: string,
): string[] {
  const sourceFile = openFiles[sourceFileId];
  const baseLabel = baseName ?? stripExtensionForLabel(sourceFile.displayName);
  const ids = labels.map(() => generateFileId());
  const sourceBpm = get().filepathsBpm[sourceFile.filePath];

  for (let i = 0; i < ids.length; i++) {
    openFiles[ids[i]] = {
      id: ids[i],
      filePath: makeManagedFilePath(ids[i]),
      displayName: `${baseLabel} ${labels[i]}`,
    };
  }

  set(
    produce((state: State) => {
      const idx = state.openFileIds.indexOf(sourceFileId);
      state.openFileIds.splice(idx + 1, 0, ...ids);
      for (const id of ids) {
        state.filesBandsPerOctave[id] = state.filesBandsPerOctave[sourceFileId];
        state.filesZoom[id] = state.filesZoom[sourceFileId];
        state.filesOffset[id] = state.filesOffset[sourceFileId];
        state.filesZoomY[id] = state.filesZoomY[sourceFileId] ?? 0;
        state.filesOffsetY[id] = state.filesOffsetY[sourceFileId] ?? 0;
        state.filesPlaybackStartTime[id] = 0;
        state.filesDirty[id] = true;
        state.persistedFilePaths[id] = openFiles[id].filePath;
        state.fileDisplayNames[id] = openFiles[id].displayName;
        if (sourceBpm !== undefined) state.filepathsBpm[openFiles[id].filePath] = sourceBpm;
        state.filesLoading[id] = loadingMessage;
      }
    }),
  );

  return ids;
}

// Remove files created for an operation that then failed, along with every
// per-file map entry seeded for them.
function discardFiles(set: ZustandSet, ids: string[]): void {
  for (const id of ids) {
    delete openFiles[id];
    disposeOnsetTexture(id);
  }
  set(
    produce((state: State) => {
      state.openFileIds = state.openFileIds.filter((id) => !ids.includes(id));
      for (const id of ids) {
        delete state.filesBandsPerOctave[id];
        delete state.filesZoom[id];
        delete state.filesOffset[id];
        delete state.filesZoomY[id];
        delete state.filesOffsetY[id];
        delete state.filesPlaybackStartTime[id];
        delete state.filesLoopRegion[id];
        delete state.filesMuted[id];
        delete state.filesSoloed[id];
        delete state.filesVolumeDb[id];
        delete state.filesSelection[id];
        delete state.filesDirty[id];
        delete state.filesLoading[id];
        delete state.persistedFilePaths[id];
        delete state.fileDisplayNames[id];
      }
    }),
  );
}

function clearLoading(set: ZustandSet, ids: string[]): void {
  set(
    produce((state: State) => {
      for (const id of ids) delete state.filesLoading[id];
    }),
  );
}

// Register a group so its members stay visibly connected. The hue comes from
// the file a split came from, or from the first member of a hand-made group, and
// every member takes it, which keeps a group to one hue of the wheel however
// many members it has.
function registerLayerStack(
  get: ZustandGet,
  method: LayerStackMethod,
  originId: string | null,
  layerIds: string[],
  label: string,
): void {
  const hueSourceId = originId ?? layerIds[0];
  const hueSource = openFiles[hueSourceId];
  const hue = hueSource ? getFileHue(hueSource.filePath) : hashHue(hueSourceId);
  for (const layerId of layerIds) {
    const member = openFiles[layerId];
    if (member) fileHues.set(member.filePath, hue);
  }
  get().createLayerStack({ method, label, originId, layerIds, hue });
}

/** The active file's loop region, or null when there is no file or no region. */
export function activeLoopRegion(state: Pick<State, "activeFileId" | "filesLoopRegion">): LoopRegion | null {
  return state.activeFileId ? (state.filesLoopRegion[state.activeFileId] ?? null) : null;
}

/** The active file's selection, or null when there is no file or no selection. */
export function activeSelection(state: Pick<State, "activeFileId" | "filesSelection">): Selection | null {
  return state.activeFileId ? (state.filesSelection[state.activeFileId] ?? null) : null;
}

/**
 * Files whose view a change to `fileId` should also move: itself, plus the rest
 * of its stem group while that group has view sync switched on.
 */
export function viewSyncTargets(state: Pick<State, "stackOfLayer" | "layerStacks">, fileId: string): string[] {
  const stackId = state.stackOfLayer[fileId];
  const group = stackId ? state.layerStacks[stackId] : undefined;
  if (!group?.syncView) return [fileId];
  return group.layerIds.includes(fileId) ? group.layerIds : [fileId, ...group.layerIds];
}

export const FILES_PERSISTED_KEYS = [
  "filepathsBpm",
  "filepathsOnsetSensitivity",
  "minimizedFileIds",
  "persistedFilePaths",
  "recentFilePaths",
  "openFileIds",
  "activeFileId",
  "fullscreenFileId",
  "filesBandsPerOctave",
  "filesZoom",
  "filesOffset",
  "filesZoomY",
  "filesOffsetY",
  "filesPlaybackStartTime",
  "filesLoopRegion",
  "filesMuted",
  "filesSoloed",
  "filesVolumeDb",
  // Persisted so the italic "unsaved" tab marker survives restart — managed
  // files in particular are always dirty until promoted via Save As.
  "filesDirty",
  // Persisted so a managed file's "Untitled N" label is stable across
  // sessions (a file the user knew as "Untitled 5" yesterday stays as
  // "Untitled 5" today instead of being renumbered by iteration order).
  "fileDisplayNames",
] as const;

export const createFilesSlice = (set: ZustandSet, get: ZustandGet): FilesState => ({
  newFile: async () => {
    const values = await new Promise<{
      sampleRate: number;
      bpm: number;
      lengthBeats: number;
    } | null>((resolve) => {
      let confirmed = false;
      openNewFilePrompt({
        onConfirm: (v) => {
          confirmed = true;
          resolve(v);
        },
        onClose: () => {
          if (!confirmed) resolve(null);
        },
      });
    });
    if (!values) return;
    const { sampleRate, bpm, lengthBeats } = values;

    const state = get();

    try {
      const lengthSeconds = (60 / bpm) * lengthBeats;
      const audioBuffer = new AudioBuffer({
        length: lengthSeconds * sampleRate,
        sampleRate,
        numberOfChannels: 2,
      });
      const analysisParams = { bandsPerOctave: state.bandsPerOctave, minFreq: state.minFreq };
      const result = await host.analysis.analyseBuffer(audioBuffer, {
        ...analysisParams,
        maxCoefficients: remainingCoefficientBudget(openFileTexelCounts()),
      });

      const spectrogramData = await spectrogramFromAnalysis(result, analysisParams);

      const fileId = generateFileId();
      const filepath = makeManagedFilePath(fileId);
      const displayName = nextUntitledName();
      openFiles[fileId] = {
        id: fileId,
        filePath: filepath,
        displayName,
        spectrogramData,
      };

      return set(
        produce((state: State) => {
          state.openFileIds.push(fileId);
          state.filepathsBpm[filepath] = bpm;
          state.filesBandsPerOctave[fileId] = state.bandsPerOctave;
          state.filesZoom[fileId] = 0;
          state.filesOffset[fileId] = 0;
          state.filesZoomY[fileId] = 0;
          state.filesOffsetY[fileId] = 0;
          state.filesPlaybackStartTime[fileId] = 0;
          state.filesDirty[fileId] = true;
          // Managed files persist across sessions; their history dir is the
          // sole on-disk backing and is rehydrated by reopenPersistedFiles.
          state.persistedFilePaths[fileId] = filepath;
          state.fileDisplayNames[fileId] = displayName;

          state.activeFileId = fileId;
        }),
      );
    } catch (error) {
      console.error("Error opening file:", error);
      notifications.show({
        title: `Failed to create file`,
        message: `Creating the new file failed. ${error instanceof Error ? error.message : ""}`,
        color: "red",
      });
    }

    console.log("Creating new file with:", { sampleRate, bpm, length });
  },
  openFileIds: [],
  openFilePath: async (filepath: string) => {
    const state = get();

    // Nothing downstream can open a path the analyser will reject, and the
    // placeholder and the Recent Files entry below would both outlive the toast.
    if (!isManagedFilePath(filepath) && !hasSupportedAudioExtension(filepath)) {
      notifications.show({
        title: "Unsupported file",
        message: `${host.path.basename(filepath)} is not an audio format Noise Canvas can open.`,
        color: "red",
      });
      return;
    }

    get().addRecentFilePath(filepath);

    // If the file is already open, activate it (un-minimizing if needed) instead of opening again
    const existing = Object.values(openFiles).find((f) => f.filePath === filepath);
    if (existing) {
      if (state.minimizedFileIds.includes(existing.id)) {
        get().setFileMinimized(existing.id, false);
      } else {
        get().setActiveFileId(existing.id);
      }
      return;
    }

    const fileId = generateFileId();
    const displayName = host.path.basename(filepath);

    // Add a placeholder immediately so the file appears in the UI with a loading
    // state. Newly opened files go to the top of the list.
    openFiles[fileId] = { id: fileId, filePath: filepath, displayName };
    set(
      produce((state: State) => {
        state.openFileIds.unshift(fileId);
        state.filepathsBpm[filepath] ??= state.mostRecentBpm ?? 120;
        state.filesBandsPerOctave[fileId] = state.bandsPerOctave;
        state.filesZoom[fileId] = 0;
        state.filesOffset[fileId] = 0;
        state.filesZoomY[fileId] = 0;
        state.filesOffsetY[fileId] = 0;
        state.filesPlaybackStartTime[fileId] = 0;
        state.filesLoading[fileId] = "Analysing audio...";
        state.persistedFilePaths[fileId] = filepath;
        state.fileDisplayNames[fileId] = displayName;
      }),
    );

    try {
      const loaded = await loadRealFileViaGaborator(fileId, filepath, state.bandsPerOctave, state.minFreq);
      if (!loaded) return;
      set(
        produce((state: State) => {
          delete state.filesLoading[fileId];
          state.activeFileId = fileId;
        }),
      );
    } catch (error) {
      // Remove the placeholder on failure
      delete openFiles[fileId];
      disposeOnsetTexture(fileId);
      set(
        produce((state: State) => {
          state.openFileIds = state.openFileIds.filter((id) => id !== fileId);
          delete state.filesLoading[fileId];
          delete state.filesBandsPerOctave[fileId];
          delete state.filesZoom[fileId];
          delete state.filesOffset[fileId];
          delete state.filesZoomY[fileId];
          delete state.filesOffsetY[fileId];
          delete state.filesPlaybackStartTime[fileId];
          delete state.filesLoopRegion[fileId];
          delete state.filesMuted[fileId];
          delete state.filesSoloed[fileId];
          delete state.filesVolumeDb[fileId];
          delete state.filesSelection[fileId];
          delete state.persistedFilePaths[fileId];
          delete state.fileDisplayNames[fileId];
        }),
      );
      console.error("Error opening file:", error);
      notifications.show({
        title: `Failed to open file`,
        message: `Opening '${truncateMiddle(host.path.basename(filepath), 50)}' failed. ${error instanceof Error ? error.message : ""}`,
        color: "red",
      });
    }
  },
  duplicateFile: async (fileId: string) => {
    const originalFile = openFiles[fileId];
    const originalSpec = originalFile?.spectrogramData;
    if (!originalFile || !originalSpec) return;

    const newFileId = generateFileId();
    const newFilePath = makeManagedFilePath(newFileId);
    const displayName = `${stripExtensionForLabel(originalFile.displayName)} copy`;

    openFiles[newFileId] = {
      id: newFileId,
      filePath: newFilePath,
      displayName,
      unprojectedPaint: originalFile.unprojectedPaint,
      onsets: originalFile.onsets?.slice(),
      onsetReference: originalFile.onsetReference
        ? {
            odfMax: originalFile.onsetReference.odfMax,
            bandMax: originalFile.onsetReference.bandMax.slice(),
          }
        : undefined,
    };

    const sourceBpm = get().filepathsBpm[originalFile.filePath];

    set(
      produce((state: State) => {
        state.openFileIds.push(newFileId);
        state.filesBandsPerOctave[newFileId] = state.filesBandsPerOctave[fileId];
        state.filesZoom[newFileId] = state.filesZoom[fileId];
        state.filesOffset[newFileId] = state.filesOffset[fileId];
        state.filesZoomY[newFileId] = state.filesZoomY[fileId] ?? 0;
        state.filesOffsetY[newFileId] = state.filesOffsetY[fileId] ?? 0;
        state.filesPlaybackStartTime[newFileId] = state.filesPlaybackStartTime[fileId];
        state.filesDirty[newFileId] = true;
        state.persistedFilePaths[newFileId] = newFilePath;
        state.fileDisplayNames[newFileId] = displayName;
        if (sourceBpm !== undefined) {
          state.filepathsBpm[newFilePath] = sourceBpm;
        }
        state.filesLoading[newFileId] = "Duplicating...";
      }),
    );

    try {
      const packedData = await copyStateIntoBlocks(originalFile, newFileId, originalSpec);
      updateOpenFile(newFileId, {
        spectrogramData: await deriveSpectrogramData(originalSpec, packedData),
      });
    } catch (error) {
      console.error("Failed to duplicate file: could not read the painted state", error);
      notifications.show({
        title: "Duplicate failed",
        message: `${error instanceof Error ? error.message : "Unknown error"}`,
        color: "red",
      });
      await destroyBlockStore(newFileId);
      discardFiles(set, [newFileId]);
      return;
    }

    clearLoading(set, [newFileId]);
    await get().setActiveFileId(newFileId);
  },
  hpssFile: async (fileId: string) => {
    const originalFile = openFiles[fileId];
    if (!originalFile) return;

    const fboData = await readCurrentPackedData(originalFile);
    if (!fboData) return;

    const { spectrogramData } = originalFile;
    if (!spectrogramData) return;

    const baseLabel = stripExtensionForLabel(originalFile.displayName);
    const ids = createStemPlaceholders(
      set,
      get,
      fileId,
      ["harmonic", "percussive"],
      "Separating harmonic and percussive...",
    );

    try {
      const { harmonic, percussive } = await host.analysis.hpss(fboData, bandLayout(spectrogramData));

      updateOpenFile(ids[0], { spectrogramData: await deriveSpectrogramData(spectrogramData, harmonic) });
      updateOpenFile(ids[1], { spectrogramData: await deriveSpectrogramData(spectrogramData, percussive) });
    } catch (error) {
      console.error("HPSS separation failed:", error);
      notifications.show({
        title: "Separation failed",
        message: `${error instanceof Error ? error.message : "Unknown error"}`,
        color: "red",
      });
      discardFiles(set, ids);
      return;
    }

    clearLoading(set, ids);
    registerLayerStack(get, "hpss", fileId, ids, `${baseLabel}: harmonic / percussive`);
  },
  nmfFile: async (fileId: string, numComponents: number) => {
    const originalFile = openFiles[fileId];
    if (!originalFile) return;

    const fboData = await readCurrentPackedData(originalFile);
    if (!fboData) return;

    const { spectrogramData } = originalFile;
    if (!spectrogramData) return;

    const parts = Math.max(2, Math.round(numComponents));
    const baseLabel = stripExtensionForLabel(originalFile.displayName);
    const labels = Array.from({ length: parts }, (_, i) => `part ${i + 1}`);
    const ids = createStemPlaceholders(set, get, fileId, labels, `Splitting into ${parts} parts...`);

    try {
      const result = await host.analysis.nmf(fboData, bandLayout(spectrogramData), parts);
      if (result.parts.length !== parts) {
        throw new Error(`Expected ${parts} parts, got ${result.parts.length}`);
      }
      for (let i = 0; i < ids.length; i++) {
        updateOpenFile(ids[i], { spectrogramData: await deriveSpectrogramData(spectrogramData, result.parts[i]) });
      }
    } catch (error) {
      console.error("NMF separation failed:", error);
      notifications.show({
        title: "Separation failed",
        message: `${error instanceof Error ? error.message : "Unknown error"}`,
        color: "red",
      });
      discardFiles(set, ids);
      return;
    }

    clearLoading(set, ids);
    registerLayerStack(get, "nmf", fileId, ids, `${baseLabel}: ${parts} parts`);
  },
  promptStackFiles: async () => {
    const openIds = get().openFileIds;
    if (openIds.length === 0) {
      notifications.show({ title: "Nothing to stack", message: "Open a file first.", color: "yellow" });
      return;
    }

    const options = openIds.map((id) => ({ id, label: openFiles[id]?.displayName ?? id }));
    const activeFileId = get().activeFileId;
    const picked = await new Promise<string[] | null>((resolve) => {
      let confirmed = false;
      openStackFilesPrompt({
        options,
        initial: activeFileId ? [activeFileId] : [],
        onConfirm: (fileIds) => {
          confirmed = true;
          resolve(fileIds);
        },
        onClose: () => {
          if (!confirmed) resolve(null);
        },
      });
    });
    if (picked) get().stackFiles(picked);
  },
  unstackActiveFile: () => {
    const fileId = get().activeFileId;
    const stackId = fileId ? get().stackOfLayer[fileId] : undefined;
    if (stackId) get().unstackLayers(stackId);
  },
  stackFiles: (fileIds: string[]) => {
    const openIds = get().openFileIds;
    const wanted = new Set(fileIds);
    // In canvas order, not the order they were ticked, so the bracket runs down
    // the lanes the way they already read.
    const layerIds = openIds.filter((id) => wanted.has(id));
    if (layerIds.length === 0) return;

    for (const id of layerIds) get().removeLayerFromStack(id);
    set(
      produce((state: State) => {
        state.openFileIds = gatherFileIds(state.openFileIds, layerIds);
      }),
    );

    const first = stripExtensionForLabel(openFiles[layerIds[0]]?.displayName ?? "Stack");
    const label = layerIds.length > 1 ? `${first} + ${layerIds.length - 1} more` : first;
    registerLayerStack(get, "user", null, layerIds, label);
  },
  addEmptyLayer: async (fileId: string) => {
    const source = openFiles[fileId];
    const spectrogramData = source?.spectrogramData;
    if (!spectrogramData) return;

    const stack = selectLayerStack(get(), fileId);
    const label = `layer ${(stack?.layerIds.length ?? 1) + 1}`;
    const baseName = stripExtensionForLabel(
      (stack?.originId && openFiles[stack.originId]?.displayName) ||
        (stack && openFiles[stack.layerIds[0]]?.displayName) ||
        source.displayName,
    );
    const ids = createStemPlaceholders(set, get, fileId, [label], "Adding layer...", baseName);

    try {
      // Zeroed coefficients on the source's own grid: silence the brush can be
      // painted straight into.
      const silence = new Float32Array(spectrogramData.texels * 4);
      updateOpenFile(ids[0], { spectrogramData: await deriveSpectrogramData(spectrogramData, silence) });
    } catch (error) {
      console.error("Failed to add a layer:", error);
      notifications.show({
        title: "Could not add a layer",
        message: `${error instanceof Error ? error.message : "Unknown error"}`,
        color: "red",
      });
      discardFiles(set, ids);
      return;
    }

    clearLoading(set, ids);

    if (stack) {
      const order = get().openFileIds;
      get().setLayerStack(ids[0], stack.id, order);
    } else {
      const baseLabel = stripExtensionForLabel(source.displayName);
      registerLayerStack(get, "user", fileId, [fileId, ids[0]], baseLabel);
    }
    await get().setActiveFileId(ids[0]);
  },

  mergeFiles: async (fileIds: string[]) => {
    if (fileIds.length < 2) return;
    const files = fileIds.map((id) => openFiles[id]);
    // Merging a subset of what was asked for would quietly drop energy, so a
    // part that hasn't finished loading blocks the whole thing.
    if (files.some((f) => !f?.spectrogramData)) {
      notifications.show({
        title: "Can't merge yet",
        message: "One of these files is still loading.",
        color: "yellow",
      });
      return;
    }

    const base = files[0].spectrogramData as SpectrogramData;
    // Adding coefficients only means anything while every part describes the
    // same grid, which is what a split leaves behind. Anything else is summed
    // as audio instead.
    const sameGrid = files.every((f) => {
      const data = f.spectrogramData as SpectrogramData;
      return (
        data.numBands === base.numBands &&
        data.numChannels === base.numChannels &&
        data.numFrames === base.numFrames &&
        data.sampleRate === base.sampleRate &&
        data.bandsPerOctave === base.bandsPerOctave &&
        data.minFreq === base.minFreq
      );
    });

    const stackId = get().stackOfLayer[fileIds[0]];
    const group = stackId ? get().layerStacks[stackId] : undefined;
    const originFile = group?.originId ? openFiles[group.originId] : undefined;
    const displayName = `${stripExtensionForLabel(originFile?.displayName ?? files[0].displayName)} merged`;

    const newFileId = generateFileId();
    const newFilePath = makeManagedFilePath(newFileId);
    openFiles[newFileId] = { id: newFileId, filePath: newFilePath, displayName };

    const sourceId = files[0].id;
    const sourceBpm = get().filepathsBpm[files[0].filePath];

    set(
      produce((state: State) => {
        const lastIdx = fileIds.reduce((max, id) => Math.max(max, state.openFileIds.indexOf(id)), -1);
        state.openFileIds.splice(lastIdx + 1, 0, newFileId);
        state.filesBandsPerOctave[newFileId] = state.filesBandsPerOctave[sourceId];
        state.filesZoom[newFileId] = state.filesZoom[sourceId];
        state.filesOffset[newFileId] = state.filesOffset[sourceId];
        state.filesZoomY[newFileId] = state.filesZoomY[sourceId] ?? 0;
        state.filesOffsetY[newFileId] = state.filesOffsetY[sourceId] ?? 0;
        state.filesPlaybackStartTime[newFileId] = 0;
        state.filesDirty[newFileId] = true;
        state.persistedFilePaths[newFileId] = newFilePath;
        state.fileDisplayNames[newFileId] = displayName;
        if (sourceBpm !== undefined) state.filepathsBpm[newFilePath] = sourceBpm;
        state.filesLoading[newFileId] = "Merging...";
      }),
    );

    try {
      if (sameGrid) {
        const merged = await mergeStatesIntoBlocks(files, newFileId, base);

        updateOpenFile(newFileId, {
          spectrogramData: {
            ...(await deriveSpectrogramData(base, merged)),
            // The parts each carry a slice of the original's energy, so none of
            // their totals describes the sum. Take the figure the split came
            // from when it's still around; the Convolve effect normalises its
            // impulse response against it.
            magnitudeEnergy: originFile?.spectrogramData?.magnitudeEnergy ?? base.magnitudeEnergy,
          },
        });
      } else {
        updateOpenFile(newFileId, { spectrogramData: await mixFilesDown(fileIds, base) });
      }
    } catch (error) {
      console.error("Merge failed:", error);
      notifications.show({
        title: "Merge failed",
        message: `${error instanceof Error ? error.message : "Unknown error"}`,
        color: "red",
      });
      await destroyBlockStore(newFileId);
      discardFiles(set, [newFileId]);
      return;
    }

    clearLoading(set, [newFileId]);
    await get().setActiveFileId(newFileId);
  },
  mergeLayerStack: async (stackId: string) => {
    const group = get().layerStacks[stackId];
    if (!group) return;
    await get().mergeFiles(group.layerIds);
  },
  closeLayerStack: async (stackId: string) => {
    const group = get().layerStacks[stackId];
    if (!group) return;
    // Closing a member dissolves the group once it drops below two, so the list
    // is snapshotted before anything is removed.
    const layerIds = [...group.layerIds];
    const unsaved = layerIds.filter((id) => get().filesDirty[id]).length;
    const confirmed = await new Promise<boolean>((resolve) => {
      openConfirm({
        title: "Close all parts",
        message:
          unsaved > 0
            ? `Close all ${layerIds.length} parts of this split? ${unsaved === 1 ? "One has" : `${unsaved} have`} unsaved changes.`
            : `Close all ${layerIds.length} parts of this split?`,
        confirmLabel: "Close All",
        danger: true,
        onConfirm: () => resolve(true),
        onCancel: () => resolve(false),
        onClose: () => resolve(false),
      });
    });
    if (!confirmed) return;
    for (const id of layerIds) get().closeFile(id);
  },
  aiSeparateFile: async (fileId: string) => {
    const originalFile = openFiles[fileId];
    if (!originalFile) return;
    const { spectrogramData } = originalFile;
    if (!spectrogramData) return;

    // Guard against re-entry: a second click during an in-flight separation would
    // spawn a duplicate set of four stem files, leaving orphaned entries behind.
    if (aiSeparatingFileIds.has(fileId)) return;
    aiSeparatingFileIds.add(fileId);

    const modelFile = "htdemucs.onnx";
    if (!host.analysis.isModelDownloaded(modelFile)) {
      notifications.show({
        id: "ai-model-download",
        title: "Downloading AI model",
        message: "Starting download…",
        color: "blue",
        loading: true,
        autoClose: false,
      });
      try {
        await host.analysis.downloadModel(modelFile, (downloaded, total) => {
          const mb = (downloaded / 1024 / 1024).toFixed(1);
          const message =
            total > 0
              ? `${Math.round((downloaded / total) * 100)}%  (${mb} / ${(total / 1024 / 1024).toFixed(1)} MB)`
              : `${mb} MB downloaded…`;
          notifications.update({
            id: "ai-model-download",
            title: "Downloading AI model",
            message,
            color: "blue",
            loading: true,
            autoClose: false,
          });
        });
        notifications.update({
          id: "ai-model-download",
          title: "AI model ready",
          message: "Model downloaded successfully.",
          color: "green",
          loading: false,
          autoClose: 3000,
        });
      } catch (error) {
        notifications.update({
          id: "ai-model-download",
          title: "Model download failed",
          message: `${error instanceof Error ? error.message : String(error)}`,
          color: "red",
          loading: false,
          autoClose: 5000,
        });
        aiSeparatingFileIds.delete(fileId);
        return;
      }
    }

    const stemNames = ["drums", "bass", "other", "vocals"];
    const baseLabel = stripExtensionForLabel(originalFile.displayName);
    const stemIds = createStemPlaceholders(set, get, fileId, stemNames, "Separating stems (AI)…");

    let audioContext: AudioContext | null = null;
    try {
      // Step 1: Synthesize the current painted state via Gaborator → get audio channels
      const channels = await currentFileAudio(originalFile);
      if (!channels) throw new Error("Could not read current spectrogram state");

      // Step 2: AI-separate the synthesized audio into stems
      const stems = await host.analysis.aiSeparate(channels, spectrogramData.sampleRate);

      // Step 3: Re-analyse each stem with Gaborator → SpectrogramData → new file entry
      const analysisParams = { bandsPerOctave: spectrogramData.bandsPerOctave, minFreq: spectrogramData.minFreq };
      audioContext = new AudioContext({ sampleRate: spectrogramData.sampleRate });

      for (let i = 0; i < stemNames.length; i++) {
        const stemChannels = stems[stemNames[i]];
        if (!stemChannels) continue;

        const numSamples = stemChannels[0].length;
        const audioBuffer = audioContext.createBuffer(stemChannels.length, numSamples, spectrogramData.sampleRate);
        for (let ch = 0; ch < stemChannels.length; ch++) {
          audioBuffer.copyToChannel(new Float32Array(stemChannels[ch]), ch);
        }

        const result = await host.analysis.analyseBuffer(audioBuffer, {
          ...analysisParams,
          maxCoefficients: remainingCoefficientBudget(openFileTexelCounts()),
        });

        updateOpenFile(stemIds[i], {
          // From analysisParams, not the current global setting — a stem has to
          // record the resolution it was actually analysed at, or it stops
          // lining up with the file it was split from.
          spectrogramData: await spectrogramFromAnalysis(result, analysisParams),
        });
      }

      audioContext.close();
      audioContext = null;
    } catch (error) {
      audioContext?.close();
      console.error("AI separation failed:", error);
      notifications.show({
        title: "AI separation failed",
        message: `${error instanceof Error ? error.message : "Unknown error"}`,
        color: "red",
      });
      discardFiles(set, stemIds);
      aiSeparatingFileIds.delete(fileId);
      return;
    }

    clearLoading(set, stemIds);
    registerLayerStack(get, "ai", fileId, stemIds, `${baseLabel}: drums / bass / other / vocals`);
    aiSeparatingFileIds.delete(fileId);
  },
  saveActiveFile: async () => {
    const state = get();
    if (!state.activeFileId) return;
    const fileId = state.activeFileId;
    const file = openFiles[fileId];
    if (!file || !file.audioBuffer) return;

    // Managed files have no real on-disk path to overwrite — Save means
    // "promote to a real file at a chosen location," which is exactly Save As.
    if (isManagedFilePath(file.filePath)) {
      await get().saveActiveFileAs();
      return;
    }

    const filePath = file.filePath;
    const fileName = host.path.basename(filePath);

    // Show confirmation modal
    return new Promise<void>((resolve) => {
      openConfirm({
        title: "Overwrite File",
        message: `Do you want to overwrite "${truncateMiddle(fileName, 50)}"?`,
        confirmLabel: "Overwrite",
        danger: true,
        onConfirm: async () => {
          try {
            const snapshot = await snapshotFileAudio(fileId);
            if (!snapshot) {
              resolve();
              return;
            }

            // Determine format from file extension
            const ext = host.path.extname(filePath).slice(1).toLowerCase();
            const format = ext || "wav";

            // Export the audio
            await host.analysis.exportAudio(snapshot.channels, filePath, snapshot.sampleRate, format);

            await getHistoryManager(fileId).markSaved(snapshot.nodeId ?? undefined);
            console.log("File saved successfully:", filePath);

            // Show success notification
            notifications.show({
              title: "File saved",
              message: `Successfully saved ${truncateMiddle(fileName, 50)}`,
            });
          } catch (error) {
            console.error("Error saving file:", error);
            // Show error notification
            notifications.show({
              title: "Save failed",
              message: `Failed to save file '${truncateMiddle(fileName, 50)}'. ${error instanceof Error ? error.message : ""}`,
              color: "red",
            });
          }
          resolve();
        },
        onCancel: () => resolve(),
      });
    });
  },
  saveActiveFileAs: async () => {
    const state = get();
    if (!state.activeFileId) return;
    const file = openFiles[state.activeFileId];
    if (!file || !file.audioBuffer) return;

    const currentFilePath = file.filePath;
    const isManaged = isManagedFilePath(currentFilePath);
    // For managed files there's no real directory to suggest — fall back to
    // userData equivalents the OS dialog already defaults to. Use just the
    // displayName as the filename suggestion.
    const defaultPath = isManaged
      ? `${file.displayName}.wav`
      : host.path.join(host.path.dirname(currentFilePath), host.path.basename(currentFilePath));

    const result = await host.dialogs.showSaveDialog({
      defaultPath,
      filters: [
        { name: "Audio Files", extensions: ["wav", "flac", "mp3"] },
        { name: "All Files", extensions: ["*"] },
      ],
    });

    if (result.canceled || !result.filePath) return;

    const outputPath = result.filePath;
    const savedFileName = host.path.basename(outputPath);
    const truncatedFileName = truncateMiddle(savedFileName, 50);

    try {
      const snapshot = await snapshotFileAudio(state.activeFileId);
      if (!snapshot) return;

      // Determine format from file extension
      const ext = host.path.extname(outputPath).slice(1).toLowerCase();
      const format = ext || "wav";

      // Export the audio
      await host.analysis.exportAudio(snapshot.channels, outputPath, snapshot.sampleRate, format);

      // Update file path in openFiles and copy BPM mapping to new path
      const oldFilePath = file.filePath;
      file.filePath = outputPath;
      file.displayName = savedFileName;
      set(
        produce((draft: State) => {
          const oldBpm = draft.filepathsBpm[oldFilePath];
          if (oldBpm !== undefined) {
            draft.filepathsBpm[outputPath] = oldBpm;
            // For managed → real promotions the sentinel BPM key is now dead;
            // for real → real renames the old path's BPM is no longer attached
            // to any open file either (a fresh open of oldFilePath would seed
            // its own entry).
            delete draft.filepathsBpm[oldFilePath];
          }
          draft.persistedFilePaths[state.activeFileId!] = outputPath;
          draft.fileDisplayNames[state.activeFileId!] = savedFileName;
          // Walk in-session brushes so any sourceFile / effect file refs that
          // pointed at the old path follow the rename. On-disk presets are
          // also rewritten below (best-effort, fire-and-forget) so a preset
          // that referenced a managed file by its sentinel path follows the
          // promotion to a real path.
          migrateBrushRefs(draft.brushes, oldFilePath, outputPath);
        }),
      );

      const presetsDir = get().presetsDir;
      if (presetsDir) {
        void migrateRefsInPresetFiles(presetsDir, oldFilePath, outputPath);
      }

      // The active file is now a real file whose exported node matches disk.
      await getHistoryManager(state.activeFileId!).markSaved(snapshot.nodeId ?? undefined);
      console.log("File saved as:", outputPath);

      // Show success notification

      notifications.show({
        title: "File saved",
        message: `Successfully saved as ${truncatedFileName}`,
      });
    } catch (error) {
      console.error("Error saving file as:", error);
      // Show error notification
      notifications.show({
        title: "Save failed",
        message: `Failed to save file '${truncatedFileName}'. ${error instanceof Error ? error.message : ""}`,
        color: "red",
      });
    }
  },
  saveActiveFileVersion: async () => {
    const state = get();
    if (!state.activeFileId) return;
    const file = openFiles[state.activeFileId];
    if (!file || !file.audioBuffer) return;

    // Versioned saves derive a new name from the source path's directory and
    // extension. Managed files have no real path to derive from — fall back
    // to Save As.
    if (isManagedFilePath(file.filePath)) {
      await get().saveActiveFileAs();
      return;
    }

    const currentFilePath = file.filePath;
    const dir = host.path.dirname(currentFilePath);
    const ext = host.path.extname(currentFilePath);
    const baseName = host.path.basename(currentFilePath, ext);

    // Check if filename ends with _NUMBER
    const versionMatch = baseName.match(/^(.+)_(\d+)$/);
    let newFileName: string;

    if (versionMatch) {
      // Increment existing version number
      const nameWithoutVersion = versionMatch[1];
      const currentVersion = parseInt(versionMatch[2], 10);
      const newVersion = currentVersion + 1;
      newFileName = `${nameWithoutVersion}_${newVersion}${ext}`;
    } else {
      // Add _1 to the filename
      newFileName = `${baseName}_1${ext}`;
    }

    const outputPath = host.path.join(dir, newFileName);
    const truncatedFileName = truncateMiddle(newFileName, 50);

    try {
      const snapshot = await snapshotFileAudio(state.activeFileId);
      if (!snapshot) return;

      // Determine format from file extension
      const format = ext.slice(1).toLowerCase() || "wav";

      // Export the audio
      await host.analysis.exportAudio(snapshot.channels, outputPath, snapshot.sampleRate, format);

      // Update file path in openFiles and copy BPM mapping to new path
      const oldFilePath = file.filePath;
      file.filePath = outputPath;
      file.displayName = newFileName;
      set(
        produce((draft: State) => {
          const oldBpm = draft.filepathsBpm[oldFilePath];
          if (oldBpm !== undefined) {
            draft.filepathsBpm[outputPath] = oldBpm;
          }
          draft.persistedFilePaths[state.activeFileId!] = outputPath;
          draft.fileDisplayNames[state.activeFileId!] = newFileName;
          // saveActiveFileVersion only runs for real files (the managed branch
          // bails out earlier), so oldFilePath is a normal filesystem path —
          // any in-session brush refs to it should follow the rename too.
          migrateBrushRefs(draft.brushes, oldFilePath, outputPath);
        }),
      );

      const presetsDir = get().presetsDir;
      if (presetsDir) {
        void migrateRefsInPresetFiles(presetsDir, oldFilePath, outputPath);
      }

      // The active file now points at the version on disk at the exported node.
      await getHistoryManager(state.activeFileId!).markSaved(snapshot.nodeId ?? undefined);
      console.log("File version saved:", outputPath);

      // Show success notification
      notifications.show({
        title: "Version saved",
        message: `Successfully saved as ${truncatedFileName}`,
      });
    } catch (error) {
      console.error("Error saving file version:", error);
      // Show error notification
      notifications.show({
        title: "Save failed",
        message: `Failed to save file '${truncatedFileName}'. ${error instanceof Error ? error.message : ""}`,
        color: "red",
      });
    }
  },
  tryCloseFile: async (fileId: string) => {
    const file = openFiles[fileId];
    if (!file) return;

    const refs = findFileReferences(file.filePath, get().brushes);
    if (refs.length > 0) {
      const fileName = file.filePath.split("/").pop() || file.filePath;
      const refList = refs.map((r) => `${r.brushName} (${r.paramLabel})`).join(", ");
      const confirmed = await new Promise<boolean>((resolve) => {
        openConfirm({
          title: "File is referenced",
          message: `"${fileName}" is referenced by: ${refList}. Closing will remove these connections.`,
          confirmLabel: "Close",
          danger: true,
          onConfirm: () => resolve(true),
          onCancel: () => resolve(false),
          onClose: () => resolve(false),
        });
      });
      if (!confirmed) return;
    }

    if (get().filesDirty[fileId]) {
      const confirmed = await new Promise<boolean>((resolve) => {
        openConfirm({
          title: "Unsaved Changes",
          message: `Are you sure you want to close this file without saving?`,
          confirmLabel: "Close",
          danger: true,
          onConfirm: () => resolve(true),
          onCancel: () => resolve(false),
          onClose: () => resolve(false),
        });
      });
      if (!confirmed) return;
    }

    // Left in place, the next stroke with that brush finds no open file at the
    // path and silently samples the destination instead.
    if (refs.length > 0) {
      set(
        produce((draft: State) => {
          clearFileReferences(file.filePath, draft.brushes);
        }),
      );
    }
    get().closeFile(fileId);
  },
  closeFile: (fileId: string) => {
    const openFile = openFiles[fileId];
    const state = get();
    if (state.isPlaying && state.activeFileId === fileId) {
      state.stopAudio();
    }
    logFileFootprint(fileId, "closed");
    fileEngineRegistry?.close(fileId);

    // Fire-and-forget: drops on-disk history directory and in-memory state.
    destroyHistoryManager(fileId).catch((err: unknown) => console.error("destroyHistoryManager failed", err));
    fileSynthesisGeneration.delete(fileId);

    state.removeLayerFromStack(fileId);

    return set(
      produce((state: State) => {
        if (openFile) {
          state.openFileIds = state.openFileIds.filter((id) => id !== fileId);
          delete state.filesBandsPerOctave[fileId];
          delete state.filesZoom[fileId];
          delete state.filesOffset[fileId];
          delete state.filesZoomY[fileId];
          delete state.filesOffsetY[fileId];
          delete state.filesPlaybackStartTime[fileId];
          delete state.filesLoopRegion[fileId];
          delete state.filesMuted[fileId];
          delete state.filesSoloed[fileId];
          delete state.filesVolumeDb[fileId];
          delete state.filesSelection[fileId];
          delete state.filesDirty[fileId];
          delete state.filesLoading[fileId];
          delete state.filesSynthesizing[fileId];
          delete state.persistedFilePaths[fileId];
          delete state.fileDisplayNames[fileId];
          state.minimizedFileIds = state.minimizedFileIds.filter((id) => id !== fileId);
          if (state.fullscreenFileId === fileId) state.fullscreenFileId = null;
          delete openFiles[fileId];
          disposeOnsetTexture(fileId);

          const nextFileId = state.openFileIds[state.openFileIds.length - 1] || null;
          if (state.activeFileId === fileId) state.activeFileId = nextFileId;
        }
      }),
    );
  },
  synthesizeFile: async (
    fileId: string,
    autoPlaybackParams?: { startTimeSeconds: number; endTimeSeconds: number } | null,
    prefetchedFboData?: Float32Array,
  ) => {
    const synthesizeFileStart = performance.now();
    console.log("[timing] synthesizeFile started");

    let settle: () => void = () => {};
    const settled = new Promise<void>((resolve) => {
      settle = resolve;
    });
    fileSynthesisSettled.set(fileId, settled);
    const finish = (): void => {
      if (fileSynthesisSettled.get(fileId) === settled) fileSynthesisSettled.delete(fileId);
      settle();
    };

    const { activeFileId, setFileSynthesizing } = get();
    if (!activeFileId) {
      finish();
      return;
    }

    let generation = 0;

    try {
      const file = openFiles[fileId];
      if (!file || !file.rendererRef?.current || !file.spectrogramData) {
        return;
      }

      setFileSynthesizing(fileId, true);

      // Undo and redo each fire their own synthesis, and the one that finishes
      // last would otherwise install its audio whatever the canvas now shows.
      generation = (fileSynthesisGeneration.get(fileId) ?? 0) + 1;
      fileSynthesisGeneration.set(fileId, generation);

      const originalAnalysis = file.spectrogramData;
      const renderer = file.rendererRef.current;

      const packedLayout: PackedLayout = {
        numFrames: originalAnalysis.numFrames,
        numChannels: originalAnalysis.numChannels,
        numBands: originalAnalysis.numBands,
        bandOffsets: originalAnalysis.synthesisMetadata.bandOffsets,
        bandStepLog2s: originalAnalysis.synthesisMetadata.bandStepLog2s,
        bandLengths: originalAnalysis.synthesisMetadata.bandLengths,
      };

      // A file whose canvas holds one window has no run of the whole of it, so
      // the audio is rebuilt a chunk at a time out of the store. Reading one
      // array out instead would hold the file's coefficients twice over. Only a
      // host that runs its analysis in spans reads a view of the packed state;
      // the rest answer whole passes and take the run.
      const canvasView = renderer.getCanvasView();
      const readSpans =
        !prefetchedFboData &&
        host.analysis.openAnalysisStream &&
        canvasView &&
        !viewCoversFile(canvasView, originalAnalysis.numFrames)
          ? (ranges: Uint32Array) => getHistoryManager(fileId).currentRanges(ranges)
          : null;

      let processedDataArray = prefetchedFboData ?? new Float32Array(0);
      if (!prefetchedFboData && !readSpans) {
        const fboStart = performance.now();
        const whole = await readCurrentPackedData(file);
        if (!whole) throw new Error("the synthesis could not read the painted state");
        processedDataArray = whole;
        diag.timing("timing", "getFBOData for synthesis", performance.now() - fboStart);
      }

      const analysisParams: AnalysisParams = {
        bandsPerOctave: originalAnalysis.bandsPerOctave,
        minFreq: originalAnalysis.minFreq,
      };

      // Check for dirty region to enable partial synthesis optimization
      const dirtyRegion = renderer.getDirtyRegion();

      const existingBuffer = file.audioBuffer;
      const canDoPartialSynthesis = dirtyRegion && existingBuffer;
      console.log("[timing] canDoPartialSynthesis:", canDoPartialSynthesis);

      let startFrame: number | undefined;
      let endFrame: number | undefined;
      let startBand: number | undefined;
      let endBand: number | undefined;
      let existingAudio: Float32Array[] | undefined;

      if (canDoPartialSynthesis) {
        // Convert UV coordinates to sample frames
        startFrame = Math.max(0, Math.floor(dirtyRegion.startX * originalAnalysis.numFrames));
        endFrame = Math.min(originalAnalysis.numFrames, Math.ceil(dirtyRegion.endX * originalAnalysis.numFrames));

        // UV Y=0 is the visual top (highest band index, highest freq); UV Y=1 is the bottom
        // (band 0, lowest freq). Invert so startBand..endBand covers the actually modified bands.
        startBand = Math.max(0, Math.floor((1.0 - dirtyRegion.endY) * originalAnalysis.numBands));
        endBand = Math.min(
          originalAnalysis.numBands,
          Math.ceil((1.0 - dirtyRegion.startY) * originalAnalysis.numBands),
        );

        // Extract existing audio channels for crossfade splicing in C++
        const extractStart = performance.now();
        existingAudio = [];
        for (let i = 0; i < existingBuffer.numberOfChannels; i++) {
          existingAudio.push(existingBuffer.getChannelData(i));
        }
        diag.timing("timing", "extract existing audio channels", performance.now() - extractStart);

        console.log("[timing] Partial synthesis range:", { startFrame, endFrame, startBand, endBand });
      }

      // Only the span the stroke touched needs its onsets found again, which on
      // a long file is the difference between a few milliseconds and walking
      // every coefficient in it. Padded either side, because an event is
      // anchored at the foot of its attack and measured for a moment after it,
      // so the ones at the edges are read from a little more material than the
      // span itself. Needs the reference from a pass that read the whole file;
      // without one this stays a whole-file pass, which then produces it.
      const onsetReference = file.onsetReference;
      if (onsetReference && startFrame !== undefined && endFrame !== undefined) {
        const sampleRate = originalAnalysis.sampleRate;
        analysisParams.detectOnsets = true;
        analysisParams.onsetStartSec = Math.max(0, startFrame / sampleRate - ONSET_REGION_PAD_SEC);
        analysisParams.onsetEndSec = Math.min(
          originalAnalysis.numFrames / sampleRate,
          endFrame / sampleRate + ONSET_REGION_PAD_SEC,
        );
        analysisParams.onsetOdfReference = onsetReference.odfMax;
        analysisParams.onsetBandMax = onsetReference.bandMax;
      } else if (!hasOnsetGate(file)) {
        // Nothing to work from yet, so this pass reads the whole file and
        // produces the reference the ones after it go on. A synthesis that
        // changed nothing — arriving at a history state, say — leaves the
        // onsets it already has alone.
        analysisParams.detectOnsets = true;
      }

      let synthesisResult;
      const cppSynthStart = performance.now();
      try {
        if (readSpans && startFrame !== undefined && endFrame !== undefined && existingAudio) {
          synthesisResult = await synthesiseRegionFromSpans(
            readSpans,
            packedLayout,
            originalAnalysis.sampleRate,
            analysisParams,
            existingAudio,
            { startFrame, endFrame, startBand: startBand ?? 0, endBand: endBand ?? packedLayout.numBands },
          );
          if (analysisParams.detectOnsets) {
            const found = await scanOnsetsFromSpans(
              readSpans,
              packedLayout,
              originalAnalysis.sampleRate,
              file,
              analysisParams,
            );
            if (found) synthesisResult = { ...synthesisResult, ...found };
          }
        } else if (readSpans) {
          // A whole-file onset pass reads each chunk with the synthesis and
          // finishes off the curves once the audio is there; a regional one
          // reads its span on its own afterwards.
          const wholeFileOnsets = analysisParams.detectOnsets && analysisParams.onsetStartSec === undefined;
          const finish = host.analysis.finishFileOnsets;
          const alongside = wholeFileOnsets
            ? chunkOnsetPass(packedLayout, originalAnalysis.sampleRate, file.onsetReference?.bandMax)
            : null;
          const chunked = await synthesiseFromSpans(
            readSpans,
            packedLayout,
            originalAnalysis.sampleRate,
            analysisParams,
            alongside ?? undefined,
          );
          synthesisResult = chunked;
          if (alongside && finish && chunked.curves && chunked.spans) {
            const onsetsStart = performance.now();
            const found = await finish(
              spanReader(readSpans),
              packedLayout,
              originalAnalysis.sampleRate,
              chunked.curves,
              chunked.spans,
              file.onsetReference!.bandMax,
            );
            diag.timing("timing", "onsets finished from curves", performance.now() - onsetsStart, {
              onsets: found.onsets.length / 2,
            });
            synthesisResult = {
              ...chunked,
              onsets: found.onsets,
              onsetOdfMax: found.odfMax,
              onsetBandMax: found.bandMax,
            };
          } else if (analysisParams.detectOnsets) {
            const found = await scanOnsetsFromSpans(
              readSpans,
              packedLayout,
              originalAnalysis.sampleRate,
              file,
              analysisParams,
            );
            if (found) synthesisResult = { ...chunked, ...found };
          }
        } else {
          // The native call references the packed buffer and existing audio in
          // place rather than copying them, so the synchronous part before the
          // promise is returned is near-zero; the FFT runs off-thread. Timing the
          // gap before the await isolates any remaining main-thread marshaling.
          const synthPromise = host.analysis.synthesize(
            processedDataArray,
            packedLayout,
            originalAnalysis.sampleRate,
            analysisParams,
            false,
            existingAudio,
            startFrame,
            endFrame,
            startBand,
            endBand,
          );
          diag.timing("timing", "synthesize marshaling on main thread", performance.now() - cppSynthStart);
          synthesisResult = await synthPromise;
        }
      } catch (synthError) {
        console.error("[timing] Synthesis failed:", synthError);
        throw synthError;
      }
      const isPartial = startFrame !== undefined;
      diag.timing("timing", "C++ synthesis", performance.now() - cppSynthStart, {
        partial: isPartial,
        chunked: Boolean(readSpans),
      });

      if (!synthesisResult || !synthesisResult.channels) {
        console.error("[timing] Invalid synthesis result:", synthesisResult);
        throw new Error("Synthesis returned invalid result");
      }

      // A newer synthesis for this file describes the canvas as it now stands.
      // The dirty region is left for that one to clear, since this result is
      // dropped rather than applied.
      if (fileSynthesisGeneration.get(fileId) !== generation) return;

      // Clear dirty region after synthesis
      renderer.clearDirtyRegion();

      await get().applySynthesizedAudio(fileId, synthesisResult, {
        autoPlaybackParams,
        onsetStartSec: analysisParams.onsetStartSec,
        onsetEndSec: analysisParams.onsetEndSec,
      });
      diag.timing("timing", "synthesizeFile total", performance.now() - synthesizeFileStart);
    } catch (error) {
      console.error("Error running synthesis:", error);
    } finally {
      // A newer synthesis owns the flag and clears it when it finishes.
      if (fileSynthesisGeneration.get(fileId) === generation) setFileSynthesizing(fileId, false);
      finish();
    }
  },
  applySynthesizedAudio: async (fileId, result, options = {}) => {
    const file = openFiles[fileId];
    if (!file?.spectrogramData || !result.channels.length) return null;

    const audioBufferStart = performance.now();
    const numChannels = result.channels.length;
    const numFrames = result.channels[0].length;
    const audioContext = Tone.getContext().rawContext;
    const audioBuffer = audioContext.createBuffer(numChannels, numFrames, file.spectrogramData.sampleRate);
    for (let i = 0; i < numChannels; i++) {
      audioBuffer.copyToChannel(result.channels[i] as Float32Array<ArrayBuffer>, i);
    }
    diag.timing("timing", "create AudioBuffer", performance.now() - audioBufferStart);

    file.audioBuffer = audioBuffer;
    file.audioPeak = result.peak > 0 ? result.peak : 1;
    file.gainReductionDb = result.gainReductionDb;
    file.maxGainReductionDb = result.maxGainReductionDb;
    file.outputLevels = options.levelWindow
      ? spliceOutputLevels(file.outputLevels, options.levelWindow, outputLevelPoints(audioBuffer))
      : (computeOutputLevels(audioBuffer) ?? undefined);
    if (result.onsets) {
      const { onsetStartSec, onsetEndSec } = options;
      file.onsets =
        onsetStartSec !== undefined && onsetEndSec !== undefined
          ? spliceOnsets(file.onsets, result.onsets, onsetStartSec, onsetEndSec)
          : result.onsets;
      if (result.onsetOdfMax !== undefined && result.onsetBandMax) {
        file.onsetReference = { odfMax: result.onsetOdfMax, bandMax: result.onsetBandMax };
      }
    }
    const { autoPlaybackParams } = options;
    // The transport belongs to the active file. Painting file A and switching to
    // B before A's synthesis returns must not restart B over A's loop bounds.
    if (autoPlaybackParams && get().activeFileId === fileId) {
      const autoPlayStart = performance.now();
      const { startTimeSeconds, endTimeSeconds } = autoPlaybackParams;
      if (get().isPlaying) await get().togglePlayback();
      get().setLoopRegion({ start: startTimeSeconds, end: endTimeSeconds });
      get().setFilePlaybackStartTime(fileId, startTimeSeconds);
      await get().togglePlayback();
      diag.timing("timing", "auto-playback setup", performance.now() - autoPlayStart);
    } else if (get().isPlaying && get().activeFileId === fileId) {
      // Swap the buffer under the player and restart it from where it was, so
      // the edit is heard without the transport moving.
      const bufferSwapStart = performance.now();
      get().swapPlayingBuffer(audioBuffer);
      diag.timing("timing", "buffer hot-swap", performance.now() - bufferSwapStart);
    }
    return audioBuffer;
  },
  spliceFileAudio: async (fileId, edits, meta) => {
    const file = openFiles[fileId];
    const source = file?.audioBuffer;
    if (!file?.spectrogramData || !source) return false;

    const channels: Float32Array[] = [];
    for (let i = 0; i < source.numberOfChannels; i++) channels.push(source.getChannelData(i).slice());
    const span = applyAudioEdits(channels, edits);

    const audioContext = Tone.getContext().rawContext;
    const audioBuffer = audioContext.createBuffer(source.numberOfChannels, source.length, source.sampleRate);
    channels.forEach((channel, i) => audioBuffer.copyToChannel(channel as Float32Array<ArrayBuffer>, i));

    // Drop what any synthesis still in flight would install, and take over the
    // busy flag it would have cleared.
    fileSynthesisGeneration.set(fileId, (fileSynthesisGeneration.get(fileId) ?? 0) + 1);
    get().setFileSynthesizing(fileId, false);

    file.audioBuffer = audioBuffer;
    file.audioPeak = meta.peak > 0 ? meta.peak : 1;
    file.gainReductionDb = meta.gainReductionDb;
    file.maxGainReductionDb = meta.maxGainReductionDb;
    if (span) {
      file.outputLevels = spliceOutputLevels(
        file.outputLevels,
        measureOutputLevels(audioBuffer, span.start, span.end),
        outputLevelPoints(audioBuffer),
      );
    }
    if (get().isPlaying && get().activeFileId === fileId) get().swapPlayingBuffer(audioBuffer);
    return true;
  },
  commitStroke: async (fileId, snapshot, source) => {
    const file = openFiles[fileId];
    if (!file?.spectrogramData) return null;

    const spec = file.spectrogramData;
    const wholeFile = projectsWholeFile(snapshot);
    const window = commitWindowOf(snapshot);
    const stroke = commitStrokeOf(snapshot, snapshot.limiterEnabled);

    const params: AnalysisParams = { bandsPerOctave: spec.bandsPerOctave, minFreq: spec.minFreq };
    // Only the span the stroke touched needs its onsets found again, padded
    // either side because an event is anchored at the foot of its attack and
    // measured for a moment after it. Without a reference from a whole-file
    // pass this reads everything, and produces one.
    const onsetReference = file.onsetReference;
    if (onsetReference && hasOnsetGate(file) && window) {
      params.detectOnsets = true;
      params.onsetStartSec = Math.max(0, window.startFrame / spec.sampleRate - ONSET_REGION_PAD_SEC);
      params.onsetEndSec = Math.min(
        spec.numFrames / spec.sampleRate,
        window.endFrame / spec.sampleRate + ONSET_REGION_PAD_SEC,
      );
      params.onsetOdfReference = onsetReference.odfMax;
      params.onsetBandMax = onsetReference.bandMax;
    } else if (!hasOnsetGate(file) || wholeFile) {
      params.detectOnsets = true;
    }

    // Without a window, or without audio to splice into, the commit rebuilds
    // the whole file — which is what the addon does when either is missing.
    // The audio goes with it either way: the limiter measures the stroke
    // against it, so a rebuild without it would hold the whole file down.
    const existingBuffer = file.audioBuffer;
    const existingAudio: Float32Array[] = [];
    if (existingBuffer) {
      for (let i = 0; i < existingBuffer.numberOfChannels; i++) existingAudio.push(existingBuffer.getChannelData(i));
    }
    const beforeMeta: AudioStateMeta = {
      peak: file.audioPeak ?? 1,
      gainReductionDb: file.gainReductionDb,
      maxGainReductionDb: file.maxGainReductionDb,
    };

    get().setFileSynthesizing(fileId, true);
    try {
      const layout: PackedLayout = {
        numFrames: spec.numFrames,
        numChannels: spec.numChannels,
        numBands: spec.numBands,
        bandOffsets: spec.synthesisMetadata.bandOffsets,
        bandStepLog2s: spec.synthesisMetadata.bandStepLog2s,
        bandLengths: spec.synthesisMetadata.bandLengths,
      };
      // A windowed call hands the addon only the window's reach instead of the
      // whole packed state. It needs a window with audio to splice into and a
      // regional onset reference, and the extension host does not speak it.
      const windowable =
        window != null &&
        !wholeFile &&
        existingAudio.length > 0 &&
        !(params.detectOnsets && params.onsetStartSec === undefined) &&
        !host.env.isExtension;
      const view = windowable && window ? commitViewOf(layout, window, spec.sampleRate) : null;

      const commitStart = performance.now();
      let data = source.data;
      // The whole painted state, read only when a pass needs all of it and
      // the caller did not hand it over: the store's committed pixels with
      // the stroke's footprint over them.
      const readWhole = async (): Promise<Float32Array> => {
        if (data) return data;
        const whole = await getHistoryManager(fileId).currentBlockState();
        if (whole && source.footprint) {
          scatterCompactPixelRanges(whole, await source.footprint.values, source.footprint.ranges);
        }
        if (!whole) throw new Error("the commit could not read the committed state");
        data = whole;
        return whole;
      };
      const commitWhole = async (): Promise<CommitStrokeResult> =>
        host.analysis.commitStroke(
          await readWhole(),
          layout,
          spec.sampleRate,
          params,
          existingAudio,
          window ?? { startFrame: -1, endFrame: -1, startBand: -1, endBand: -1 },
          stroke,
        );
      let usedView = false;
      let viewFromStore = false;
      let viewBuffer: Float32Array | null = null;
      let preparedDelta: PreparedDelta | null = null;
      let baseFootprint: Float32Array | null = null;
      let viewReadMs = 0;
      let storeReadMs = 0;
      let paintedReadMs = 0;
      let prepareMs = 0;
      let result: CommitStrokeResult;
      // The store's background flush waits while the commit runs, so the two
      // do not share the machine.
      const resumeFlush = (await getBlockStore(fileId))?.pauseFlush() ?? (() => {});
      try {
        if (view && window) {
          // The view's pre-stroke pixels come from the block store, read while
          // the stroke's own pixels come off the canvas, and those are written
          // over them; only when the store cannot serve them is the view
          // gathered from a whole readback. Before the stroke goes over them,
          // they give the history its delta, or the footprint's old values
          // when a projection will widen what the delta covers.
          const footprint = source.footprint;
          if (footprint && viewHolds(view, footprint.ranges)) {
            const readStart = performance.now();
            const [preStroke, values] = await Promise.all([
              getHistoryManager(fileId)
                .currentRanges(view.ranges)
                .finally(() => (storeReadMs = performance.now() - readStart)),
              Promise.resolve(footprint.values).finally(() => (paintedReadMs = performance.now() - readStart)),
            ]);
            viewReadMs = performance.now() - readStart;
            if (preStroke) {
              const prepareStart = performance.now();
              const prepare = snapshot.reanalyzeEnabled ? undefined : host.analysis.prepareHistoryDelta;
              if (prepare) {
                preparedDelta = {
                  ranges: footprint.ranges,
                  ...(await prepare(preStroke, view.ranges, values, footprint.ranges)),
                };
              } else {
                baseFootprint = new Float32Array(values.length);
                copyCompactOverlap(baseFootprint, footprint.ranges, preStroke, view.ranges);
              }
              prepareMs = performance.now() - prepareStart;
              viewBuffer = composeViewBuffer(preStroke, view, values, footprint.ranges);
              viewFromStore = viewBuffer != null;
            }
          }
          if (!viewBuffer) viewBuffer = gatherPixelRanges(await readWhole(), view.ranges);
          try {
            result = await host.analysis.commitStroke(
              viewBuffer,
              { ...layout, viewStartFrame: view.startFrame, viewEndFrame: view.endFrame },
              spec.sampleRate,
              params,
              existingAudio,
              window,
              stroke,
            );
            usedView = true;
          } catch (error) {
            if (!(error instanceof Error) || !/view/.test(error.message)) throw error;
            // The view fell short of a pass's reach; the whole state still
            // commits correctly, at the cost of reading all of it.
            console.error("windowed commit fell back to the whole state:", error);
            result = await commitWhole();
          }
        } else {
          result = await commitWhole();
        }
      } finally {
        resumeFlush();
      }
      if (usedView && view && viewBuffer && data) {
        scatterCommitPatch(data, view, viewBuffer, result.patch.ranges, layout);
        // The residuals that make the tail invertible are collected by the
        // history's own turn walk over the block store, not from this copy.
        if (result.tailApplied === false && hasPhaseTurns(result.tail)) {
          applyPhaseTurns(data, result.tail, false);
        }
      }
      diag.timing("timing", "commitStroke", performance.now() - commitStart, {
        bandRanges: result.patch.ranges.length / 3,
        windowed: usedView ? 1 : 0,
        viewFromStore: viewFromStore ? 1 : 0,
        viewReadMs: Math.round(viewReadMs),
        storeReadMs: Math.round(storeReadMs),
        paintedReadMs: Math.round(paintedReadMs),
        prepareMs: Math.round(prepareMs),
        ...result.phases,
      });

      if (snapshot.reanalyzeEnabled) file.unprojectedPaint = false;
      else if (snapshot.dirtyRegion) file.unprojectedPaint = true;

      // Cut before the result is installed: the slices read the buffer the
      // commit was measured against.
      const audioHop = buildAudioHop({
        existing: existingAudio,
        result: result.channels,
        start: result.audioWindow.start,
        end: result.audioWindow.end,
        beforeMeta,
        afterMeta: {
          peak: result.peak > 0 ? result.peak : 1,
          gainReductionDb: result.gainReductionDb,
          maxGainReductionDb: result.maxGainReductionDb,
        },
      });

      const audioBuffer = await get().applySynthesizedAudio(fileId, result, {
        autoPlaybackParams: snapshot.autoPlaybackParams,
        onsetStartSec: params.onsetStartSec,
        onsetEndSec: params.onsetEndSec,
        levelWindow: window ? result.levels : undefined,
      });
      return {
        result,
        audioBuffer,
        audioHop,
        view: usedView ? view : null,
        viewBuffer: usedView ? viewBuffer : null,
        data: data ?? null,
        preparedDelta,
        baseFootprint,
      };
    } finally {
      get().setFileSynthesizing(fileId, false);
    }
  },
  /**
   * Put a file's onsets back to the ones belonging to a history node — after an
   * undo, or on reopening. Stored with the node where possible; a node from
   * before they were stored, or one whose file has gone, is detected once and
   * then stored, so a history heals as it is used.
   */
  restoreOnsetsForNode: async (fileId: string, nodeId: string, packedData?: Float32Array): Promise<void> => {
    const file = openFiles[fileId];
    if (!file?.spectrogramData) return;
    const historyManager = getHistoryManager(fileId);

    try {
      const stored = await historyManager.getNodeOnsets(nodeId);
      const state = stored ? unpackOnsetState(stored) : null;
      if (state) {
        file.onsets = state.onsets;
        file.onsetReference = state.reference;
        return;
      }

      const spectrogramData = file.spectrogramData;
      const grid = blockGrid(
        { numBands: spectrogramData.numBands, metadata: spectrogramData.metadata },
        spectrogramData.numFrames,
        spectrogramData.sampleRate,
      );
      const windowed = needsCanvasWindow(grid, canvasWindowBlocks(grid));
      if (windowed && host.analysis.scanFileOnsets) {
        const scan = host.analysis.scanFileOnsets;
        const packedLayout: PackedLayout = {
          numBands: spectrogramData.numBands,
          numChannels: spectrogramData.numChannels,
          numFrames: spectrogramData.numFrames,
          bandOffsets: spectrogramData.synthesisMetadata.bandOffsets,
          bandLengths: spectrogramData.synthesisMetadata.bandLengths,
          bandStepLog2s: spectrogramData.synthesisMetadata.bandStepLog2s,
        };
        const result = await scan(
          spanReader((ranges) => historyManager.currentRanges(ranges)),
          packedLayout,
          spectrogramData.sampleRate,
          new Float32Array(0),
        );
        file.onsets = result.onsets;
        file.onsetReference = { odfMax: result.odfMax, bandMax: result.bandMax };
        await historyManager.setNodeOnsets(
          nodeId,
          packOnsetState({ onsets: result.onsets, reference: file.onsetReference }),
        );
        return;
      }

      // Without stored onsets the coefficients are walked in full, from
      // whichever whole copy is cheapest to come by.
      const packed = packedData ?? (await getHistoryManager(fileId).currentBlockState());
      if (!packed) return;
      const result = await host.analysis.detectOnsets(
        packed,
        {
          numBands: spectrogramData.numBands,
          numChannels: spectrogramData.numChannels,
          numFrames: spectrogramData.numFrames,
          bandOffsets: spectrogramData.synthesisMetadata.bandOffsets,
          bandLengths: spectrogramData.synthesisMetadata.bandLengths,
          bandStepLog2s: spectrogramData.synthesisMetadata.bandStepLog2s,
        },
        spectrogramData.sampleRate,
      );
      file.onsets = result.onsets;
      file.onsetReference = { odfMax: result.odfMax, bandMax: result.bandMax };
      await historyManager.setNodeOnsets(
        nodeId,
        packOnsetState({ onsets: result.onsets, reference: file.onsetReference }),
      );
    } catch (error) {
      // Losing the onsets costs the markers and the onset grid, not the file.
      console.error("Onsets for history node failed:", error);
    }
  },

  loadCachedAudio: async (fileId: string, audioPath: string, peak: number): Promise<boolean> => {
    const file = openFiles[fileId];
    if (!file?.spectrogramData) return false;

    const { setFileSynthesizing } = get();

    try {
      setFileSynthesizing(fileId, true);

      const sampleRate = file.spectrogramData.sampleRate;
      const numChannels = file.spectrogramData.numChannels;
      const channels = await host.analysis.decodeAudio(audioPath, sampleRate, numChannels);
      if (!channels.length || !channels[0].length) return false;

      const audioContext = Tone.getContext().rawContext;
      const audioBuffer = audioContext.createBuffer(numChannels, channels[0].length, sampleRate);
      for (let i = 0; i < numChannels; i++) {
        audioBuffer.copyToChannel(channels[i] as Float32Array<ArrayBuffer>, i);
      }

      file.audioBuffer = audioBuffer;
      file.audioPeak = peak > 0 ? peak : 1;
      // Cached audio carries no gain-reduction envelope.
      file.gainReductionDb = undefined;
      file.maxGainReductionDb = undefined;
      file.outputLevels = computeOutputLevels(audioBuffer) ?? undefined;

      // Hot-swap if currently playing this file
      if (get().isPlaying && get().activeFileId === fileId) {
        get().swapPlayingBuffer(audioBuffer);
      }

      return true;
    } catch (error) {
      console.error("Failed to load cached undo audio:", error);
      return false;
    } finally {
      setFileSynthesizing(fileId, false);
    }
  },
  exportHistory: async () => {
    const state = get();
    if (!state.activeFileId) return;
    const file = openFiles[state.activeFileId];
    if (!file) return;

    const historyManager = getHistoryManager(state.activeFileId);
    await historyManager.initialize();
    const manifest = historyManager.getManifest();
    if (!manifest) {
      notifications.show({
        title: "Nothing to export",
        message: "No history for this file yet.",
        color: "yellow",
      });
      return;
    }

    const result = await host.dialogs.showDirectoryDialog({
      title: "Export History",
      buttonLabel: "Export Here",
    });
    if (result.canceled || !result.filePaths || result.filePaths.length === 0) return;
    const outputRoot = result.filePaths[0];

    const pathOf = buildChildIndexPaths(manifest);

    // Leaves (no children) → one root-to-leaf path per leaf.
    const leafIds = Object.values(manifest.nodes)
      .filter((n) => n.childIds.length === 0)
      .map((n) => n.id);
    const chains = leafIds.map((id) => chainFromRootTo(manifest, id));

    await runHistoryExport({
      historyManager,
      manifest,
      chains,
      outputRoot,
      pathOf,
      folderFor: (i) => `path-${String(i + 1).padStart(Math.max(2, String(chains.length).length), "0")}`,
      writeTreeJson: true,
      successNoun: `path${chains.length === 1 ? "" : "s"}`,
      successCount: chains.length,
    });
  },
  exportHistoryFavorites: async () => {
    const state = get();
    if (!state.activeFileId) return;
    const historyManager = getHistoryManager(state.activeFileId);
    await historyManager.initialize();
    const manifest = historyManager.getManifest();
    if (!manifest) {
      notifications.show({ title: "Nothing to export", message: "No history yet.", color: "yellow" });
      return;
    }

    const favorites = Object.values(manifest.nodes)
      .filter((n) => n.favorited)
      .sort((a, b) => a.timestamp - b.timestamp);
    if (favorites.length === 0) {
      notifications.show({
        title: "No favourites",
        message: "Favourite nodes via the right-click menu first.",
        color: "yellow",
      });
      return;
    }

    const result = await host.dialogs.showDirectoryDialog({
      title: "Export Favourites",
      buttonLabel: "Export Here",
    });
    if (result.canceled || !result.filePaths || result.filePaths.length === 0) return;
    const outputRoot = result.filePaths[0];

    const pathOf = buildChildIndexPaths(manifest);
    // One single-node "chain" per favorite — runHistoryExport already dedups
    // per node and writes to the root folder when folderFor returns null.
    const chains = favorites.map((n) => [n.id]);

    await runHistoryExport({
      historyManager,
      manifest,
      chains,
      outputRoot,
      pathOf,
      folderFor: () => null,
      writeTreeJson: false,
      successNoun: `favorite${favorites.length === 1 ? "" : "s"}`,
      successCount: favorites.length,
      omitOrdinal: true,
    });
  },
  exportHistoryBranch: async (nodeId: string) => {
    const state = get();
    if (!state.activeFileId) return;
    const historyManager = getHistoryManager(state.activeFileId);
    await historyManager.initialize();
    const manifest = historyManager.getManifest();
    if (!manifest || !manifest.nodes[nodeId]) {
      notifications.show({ title: "Nothing to export", message: "Node no longer exists.", color: "yellow" });
      return;
    }

    const result = await host.dialogs.showDirectoryDialog({
      title: "Export Branch",
      buttonLabel: "Export Here",
    });
    if (result.canceled || !result.filePaths || result.filePaths.length === 0) return;
    const outputRoot = result.filePaths[0];

    const pathOf = buildChildIndexPaths(manifest);
    const chain = chainFromRootTo(manifest, nodeId);

    // Branch exports dump WAVs directly in the selected folder — no wrapper
    // subdirectory, since it's a single path.
    await runHistoryExport({
      historyManager,
      manifest,
      chains: [chain],
      outputRoot,
      pathOf,
      folderFor: () => null,
      writeTreeJson: false,
      successNoun: "node",
      successCount: chain.length,
    });
  },
  exportHistoryBranchToLive: async (nodeId: string) => {
    const state = get();
    if (!state.activeFileId || !host.session) return;
    const historyManager = getHistoryManager(state.activeFileId);
    await historyManager.initialize();
    const manifest = historyManager.getManifest();
    if (!manifest || !manifest.nodes[nodeId]) {
      notifications.show({ title: "Nothing to export", message: "Node no longer exists.", color: "yellow" });
      return;
    }

    const chain = chainFromRootTo(manifest, nodeId);
    const notificationId = `branch-to-live-${nodeId}`;
    notifications.show({
      id: notificationId,
      title: "Rendering branch",
      message: `Synthesising ${chain.length} state${chain.length === 1 ? "" : "s"}…`,
      loading: true,
      autoClose: false,
      withCloseButton: false,
    });

    const renders: HostRender[] = [];
    for (const id of chain) {
      const node = manifest.nodes[id];
      if (!node) continue;
      const audio = await historyManager.synthesizeNodeAudio(id);
      if (!audio) continue;
      renders.push({ channels: audio.channels, sampleRate: audio.sampleRate, label: node.customLabel ?? node.label });
    }

    if (renders.length === 0) {
      notifications.update({
        id: notificationId,
        title: "Nothing to export",
        message: "Could not render any states in this branch.",
        loading: false,
        autoClose: 4000,
        color: "yellow",
      });
      return;
    }

    notifications.hide(notificationId);
    await host.session.apply(renders);
  },
  reanalyzeFile: async (fileId, bandsPerOctave) => {
    const file = openFiles[fileId];
    if (!file) return;
    const { minFreq } = get();
    const audioBuffer = file.audioBuffer;

    set(
      produce((state: State) => {
        state.filesLoading[fileId] = "Analysing audio...";
      }),
    );

    try {
      // Queued against stroke commits and history navigation: those derive their
      // result from the old dimensions, and applying one afterwards would write
      // old-sized coefficients into the new analysis.
      await serializeFileTask(fileId, async () => {
        const reanalysisParams: AnalysisParams = {
          bandsPerOctave,
          minFreq,
          maxCoefficients: remainingCoefficientBudget(openFileTexelCounts(fileId)),
        };
        const analysisStart = performance.now();
        const result = audioBuffer
          ? await host.analysis.analyseBuffer(audioBuffer, reanalysisParams)
          : await host.analysis.analyze(file.filePath, reanalysisParams);
        const analysisMs = performance.now() - analysisStart;

        const spectrogramData = await spectrogramFromAnalysis(result, { minFreq, bandsPerOctave });
        const reshaped = spectrogramData.packedData;

        if (!openFiles[fileId]) return;

        file.spectrogramData = spectrogramData;
        file.unprojectedPaint = false;
        diag.timing("file", "re-analysis", analysisMs, { name: host.path.basename(file.filePath), bandsPerOctave });

        reloadFileEngine(fileId);

        await getHistoryManager(fileId).addSnapshot({
          data: reshaped,
          kind: "reanalyze",
          label: "Re-analyse",
          spectrogram: spectrogramData,
        });
        file.rendererRef?.current?.releaseAnalysisData();

        set(
          produce((state: State) => {
            state.bandsPerOctave = bandsPerOctave;
            state.filesBandsPerOctave[fileId] = bandsPerOctave;
          }),
        );
      });
    } catch (error) {
      console.error("Error during re-analysis:", error);
      notifications.show({
        title: "Re-analysis failed",
        message: `${error instanceof Error ? error.message : "Unknown error"}`,
        color: "red",
      });
    } finally {
      set(
        produce((state: State) => {
          delete state.filesLoading[fileId];
        }),
      );
    }
  },
  resizeActiveFileLength: (factor: 2 | 0.5) =>
    serializeEditCommand(async () => {
      const fileId = get().activeFileId;
      const file = fileId ? openFiles[fileId] : undefined;
      if (!fileId || !file) return;

      // The resize moves the onsets rigidly: doubling repeats the map a file
      // length later, halving keeps the first half.
      const spec = file.spectrogramData;
      const fileOnsets = file.onsets;
      const duration = spec ? spec.numFrames / spec.sampleRate : 0;
      const precomputedOnsets =
        spec && fileOnsets
          ? {
              onsets:
                factor === 2
                  ? insertOnsetSpan(fileOnsets, duration, duration, fileOnsets)
                  : removeOnsetSpan(fileOnsets, duration / 2, duration),
              reference: file.onsetReference,
            }
          : undefined;

      try {
        await rebuildFileFromCurrentAudio(
          set,
          fileId,
          (channels) =>
            channels.map((src) => {
              const newLength = factor === 2 ? src.length * 2 : Math.floor(src.length / 2);
              if (newLength <= 0) throw new Error("The file is too short to halve.");
              const dst = new Float32Array(newLength);
              if (factor === 2) {
                dst.set(src, 0);
                dst.set(src, src.length);
              } else {
                dst.set(src.subarray(0, newLength), 0);
              }
              return dst;
            }),
          { kind: "resize", label: "Resize" },
          undefined,
          precomputedOnsets,
          (oldFrames) =>
            factor === 2
              ? [
                  { newStart: 0, oldStart: 0, length: oldFrames },
                  { newStart: oldFrames, oldStart: 0, length: oldFrames },
                ]
              : [{ newStart: 0, oldStart: 0, length: Math.floor(oldFrames / 2) }],
        );
      } catch (error) {
        console.error("Resize failed:", error);
        notifications.show({
          title: "Resize failed",
          message: error instanceof Error ? error.message : "Unknown error",
          color: "red",
        });
      }
    }),
  setActiveFileLength: async () => {
    const fileId = get().activeFileId;
    const file = fileId ? openFiles[fileId] : undefined;
    if (!fileId || !file?.spectrogramData) return;
    if (get().filesLoading[fileId] || get().filesBusy[fileId]) return;

    const spec = file.spectrogramData;
    const values = await new Promise<LengthValues | null>((resolve) => {
      let confirmed = false;
      openSetLengthPrompt({
        seconds: spec.numFrames / spec.sampleRate,
        bpm: get().filepathsBpm[file.filePath] || 120,
        onConfirm: (v) => {
          confirmed = true;
          resolve(v);
        },
        onClose: () => {
          if (!confirmed) resolve(null);
        },
      });
    });
    if (!values) return;

    await serializeEditCommand(async () => {
      const current = openFiles[fileId];
      if (!current?.spectrogramData) return;
      const { sampleRate, numFrames } = current.spectrogramData;
      const seconds = lengthToSeconds(values, get().filepathsBpm[current.filePath] || 120);
      const target = quantizeSpliceLength(Math.round(seconds * sampleRate), sampleRate);
      if (target <= 0 || target === numFrames) return;

      // Cutting drops the onsets past the new end; padding leaves every one of
      // them where it was, so the map is spliced rather than detected again.
      const fileOnsets = current.onsets;
      const precomputedOnsets = fileOnsets
        ? {
            onsets:
              target < numFrames
                ? removeOnsetSpan(fileOnsets, target / sampleRate, numFrames / sampleRate)
                : fileOnsets,
            reference: current.onsetReference,
          }
        : undefined;

      const clearBusy = () =>
        set(
          produce((state: State) => {
            delete state.filesBusy[fileId];
          }),
        );
      set(
        produce((state: State) => {
          state.filesBusy[fileId] = target < numFrames ? "Trimming..." : "Padding...";
        }),
      );

      try {
        await rebuildFileFromCurrentAudio(
          set,
          fileId,
          (channels) => setChannelsLength(channels, target),
          { kind: "resize", label: "Set length" },
          clearBusy,
          precomputedOnsets,
          (oldFrames) => [{ newStart: 0, oldStart: 0, length: Math.min(oldFrames, target) }],
        );
      } catch (error) {
        console.error("Set length failed:", error);
        notifications.show({
          title: "Set length failed",
          message: error instanceof Error ? error.message : "Unknown error",
          color: "red",
        });
      } finally {
        clearBusy();
      }
    });
  },
  insertSilenceIntoActiveFile: async () => {
    const fileId = get().activeFileId;
    const file = fileId ? openFiles[fileId] : undefined;
    if (!fileId || !file?.spectrogramData) return;
    if (get().filesLoading[fileId] || get().filesBusy[fileId]) return;

    // With a selection, the silence takes the selection's own place and
    // length; the dialog only asks when there is nothing to measure.
    let values: LengthValues | null = null;
    if (!get().filesSelection[fileId]) {
      values = await new Promise<LengthValues | null>((resolve) => {
        let confirmed = false;
        openInsertSilencePrompt({
          bpm: get().filepathsBpm[file.filePath] || 120,
          onConfirm: (v) => {
            confirmed = true;
            resolve(v);
          },
          onClose: () => {
            if (!confirmed) resolve(null);
          },
        });
      });
      if (!values) return;
    }

    await serializeEditCommand(async () => {
      const current = openFiles[fileId];
      if (!current?.spectrogramData) return;
      const { sampleRate, numFrames } = current.spectrogramData;
      const selection = get().filesSelection[fileId];

      let requestedPad: number;
      let cutSample: number;
      if (selection) {
        requestedPad = Math.round((selection.end - selection.start) * sampleRate);
        cutSample = silenceCutSample(numFrames, selection.start * sampleRate);
      } else if (values) {
        const seconds = lengthToSeconds(values, get().filepathsBpm[current.filePath] || 120);
        requestedPad = Math.round(seconds * sampleRate);
        cutSample = silenceCutSample(numFrames, (get().filesPlaybackStartTime[fileId] ?? 0) * sampleRate);
      } else {
        return;
      }
      if (requestedPad <= 0) return;
      const padSamples = quantizeSpliceLength(requestedPad, sampleRate);

      // The silence moves the onsets rigidly, so the rebuild splices the map
      // instead of detecting it again.
      const fileOnsets = current.onsets;
      const precomputedOnsets = fileOnsets
        ? {
            onsets: insertOnsetSpan(fileOnsets, cutSample / sampleRate, padSamples / sampleRate, new Float32Array(0)),
            reference: current.onsetReference,
          }
        : undefined;

      const clearBusy = () =>
        set(
          produce((state: State) => {
            delete state.filesBusy[fileId];
          }),
        );
      set(
        produce((state: State) => {
          state.filesBusy[fileId] = "Inserting silence...";
        }),
      );

      try {
        await rebuildFileFromCurrentAudio(
          set,
          fileId,
          (channels) => insertSilence(channels, cutSample, padSamples),
          { kind: "resize", label: "Insert silence" },
          () => {
            clearBusy();
            // The silence is what the edit made, so it is what stays selected.
            if (selection) {
              const startSec = cutSample / sampleRate;
              get().setFileSelection(fileId, fullHeightSelection(startSec, startSec + padSamples / sampleRate));
              get().setFilePlaybackStartTime(fileId, startSec);
            }
          },
          precomputedOnsets,
          (oldFrames) => insertSpanPieces(oldFrames, cutSample, padSamples, 0),
        );
      } catch (error) {
        console.error("Insert silence failed:", error);
        notifications.show({
          title: "Insert silence failed",
          message: error instanceof Error ? error.message : "Unknown error",
          color: "red",
        });
      } finally {
        clearBusy();
      }
    });
  },
  setFileChannelCount: async (fileId, channelCount) => {
    const file = openFiles[fileId];
    if (!file?.spectrogramData || file.spectrogramData.numChannels === channelCount) return;
    if (get().filesLoading[fileId]) return;

    set(
      produce((state: State) => {
        state.filesLoading[fileId] = channelCount === 1 ? "Mixing down to mono..." : "Spreading to stereo...";
      }),
    );

    try {
      await rebuildFileFromCurrentAudio(set, fileId, (channels) => toChannelCount(channels, channelCount), {
        kind: "reanalyze",
        label: channelCount === 1 ? "To mono" : "To stereo",
      });
    } catch (error) {
      console.error("Channel change failed:", error);
      notifications.show({
        title: "Channel change failed",
        message: error instanceof Error ? error.message : "Unknown error",
        color: "red",
      });
    } finally {
      set(
        produce((state: State) => {
          delete state.filesLoading[fileId];
        }),
      );
    }
  },
  filepathsBpm: {},
  setFilepathBpm: (filepath, bpm) =>
    set(
      produce((state: State) => {
        state.filepathsBpm[filepath] = bpm;
        state.mostRecentBpm = bpm;
      }),
    ),
  filepathsOnsetSensitivity: {},
  setFilepathOnsetSensitivity: (filepath, sensitivity) =>
    set(
      produce((state: State) => {
        state.filepathsOnsetSensitivity[filepath] = sensitivity;
      }),
    ),
  mostRecentBpm: null,
  setMostRecentBpm: (bpm: number) => set({ mostRecentBpm: bpm }),
  filesBandsPerOctave: {},
  setFileBandsPerOctave: (fileId, bandsPerOctave) =>
    set(
      produce((state: State) => {
        state.filesBandsPerOctave[fileId] = bandsPerOctave;
      }),
    ),
  filesZoom: {},
  setFileZoom: (fileId: string, zoom: number) =>
    set(
      produce((state: State) => {
        for (const id of viewSyncTargets(state, fileId)) state.filesZoom[id] = zoom;
      }),
    ),
  filesOffset: {},
  setFileOffset: (fileId: string, offset: number) =>
    set(
      produce((state: State) => {
        for (const id of viewSyncTargets(state, fileId)) state.filesOffset[id] = offset;
      }),
    ),
  setFileZoomAndOffset: (fileId: string, zoom: number, offset: number) =>
    set(
      produce((state: State) => {
        for (const id of viewSyncTargets(state, fileId)) {
          state.filesZoom[id] = zoom;
          state.filesOffset[id] = offset;
        }
      }),
    ),
  filesZoomY: {},
  setFileZoomY: (fileId: string, zoom: number) =>
    set(
      produce((state: State) => {
        for (const id of viewSyncTargets(state, fileId)) state.filesZoomY[id] = zoom;
      }),
    ),
  filesOffsetY: {},
  setFileOffsetY: (fileId: string, offset: number) =>
    set(
      produce((state: State) => {
        for (const id of viewSyncTargets(state, fileId)) state.filesOffsetY[id] = offset;
      }),
    ),
  setFileZoomAndOffsetY: (fileId: string, zoom: number, offset: number) =>
    set(
      produce((state: State) => {
        for (const id of viewSyncTargets(state, fileId)) {
          state.filesZoomY[id] = zoom;
          state.filesOffsetY[id] = offset;
        }
      }),
    ),
  persistedFilePaths: {},
  fileDisplayNames: {},
  recentFilePaths: [],
  addRecentFilePath: (filePath: string) => {
    set(
      produce((state: State) => {
        const filtered = state.recentFilePaths.filter((p) => p !== filePath);
        filtered.unshift(filePath);
        state.recentFilePaths = filtered.slice(0, 20);
      }),
    );
  },
  clearRecentFilePaths: () => {
    set(
      produce((state: State) => {
        state.recentFilePaths = [];
      }),
    );
  },
  reopenPersistedFiles: async () => {
    const state = get();
    const entries = Object.entries(state.persistedFilePaths);
    if (entries.length === 0) return;

    // Pull the untitled counter forward past any persisted "Untitled N"
    // labels so a freshly-created managed file later in the session doesn't
    // collide with one we're rehydrating.
    for (const persistedName of Object.values(state.fileDisplayNames)) {
      const m = /^Untitled (\d+)$/.exec(persistedName);
      if (m) bumpUntitledCounterTo(parseInt(m[1], 10));
    }

    const newlyAssigned: Record<string, string> = {};
    for (const [fileId, filePath] of entries) {
      // Prefer the persisted label so a managed file's "Untitled N" stays
      // stable across sessions. Fall back to a freshly-derived label only
      // when a persisted entry has no name (legacy state, or a prior bug).
      const persisted = state.fileDisplayNames[fileId];
      const displayName =
        persisted ?? (isManagedFilePath(filePath) ? nextUntitledName() : host.path.basename(filePath));
      if (!persisted) newlyAssigned[fileId] = displayName;
      openFiles[fileId] ??= { id: fileId, filePath, displayName };
    }
    // Persist any names we had to invent for entries missing a label so the
    // next session is fully stable.
    if (Object.keys(newlyAssigned).length > 0) {
      set(
        produce((draft: State) => {
          for (const [id, name] of Object.entries(newlyAssigned)) {
            draft.fileDisplayNames[id] = name;
          }
        }),
      );
    }
    set(
      produce((draft: State) => {
        for (const [fileId] of entries) {
          draft.filesLoading[fileId] = "Loading...";
        }
      }),
    );

    await Promise.all(
      entries.map(async ([fileId, filePath]) => {
        try {
          // History is the source of truth on reopen — skip gaborator entirely.
          // The root snapshot has full SpectrogramData (dimensions + inverseMap
          // + metadata + synthesisMetadata) and stroke deltas reproduce the
          // painted state at currentId.
          const historyManager = getHistoryManager(fileId);
          const hadExisting = await historyManager.initialize();
          if (!hadExisting) {
            // No on-disk history: this can only happen if persistedFilePaths
            // got out of sync (e.g. a crash between addRootSnapshot and the
            // store persist write). For real files we can fall back to
            // gaborator — for managed files there's no fallback.
            if (isManagedFilePath(filePath)) {
              throw new Error("No history found for managed file");
            }
            const pathState = get();
            await loadRealFileViaGaborator(
              fileId,
              filePath,
              pathState.filesBandsPerOctave[fileId] ?? pathState.bandsPerOctave,
              pathState.minFreq,
            );
            set(
              produce((draft: State) => {
                delete draft.filesLoading[fileId];
              }),
            );
            return;
          }
          const spectrogramData = await historyManager.loadSpectrogramAtCurrent();
          if (!spectrogramData) throw new Error("History tree is empty");
          // History restores a file without going near the analyser, so the
          // admission check every other path runs has to be repeated here.
          // Without it a file admitted by an earlier version, or on a roomier
          // machine, reopens at any size and exhausts the GPU pool.
          const otherTexelCounts = openFileTexelCounts(fileId);
          const allowed = remainingCoefficientBudget(otherTexelCounts);
          const coefficients = spectrogramData.texels;
          if (allowed !== undefined && coefficients > allowed) {
            throw new Error(
              otherTexelCounts.length > 0
                ? "There is not enough graphics memory for this file. Close another file to free graphics memory."
                : "There is not enough graphics memory for this file.",
            );
          }
          if (!updateOpenFile(fileId, { spectrogramData })) return;
          // Restored from the node the file reopens on, before the loading flag
          // clears, so its first paint already has them.
          const currentId = historyManager.getManifest()?.currentId;
          if (currentId) {
            await get().restoreOnsetsForNode(fileId, currentId, spectrogramData.packedData);
          }
          set(
            produce((draft: State) => {
              delete draft.filesLoading[fileId];
            }),
          );
        } catch (error) {
          delete openFiles[fileId];
          disposeOnsetTexture(fileId);
          set(
            produce((draft: State) => {
              draft.openFileIds = draft.openFileIds.filter((id) => id !== fileId);
              draft.minimizedFileIds = draft.minimizedFileIds.filter((id) => id !== fileId);
              if (draft.activeFileId === fileId) draft.activeFileId = null;
              if (draft.fullscreenFileId === fileId) draft.fullscreenFileId = null;
              delete draft.persistedFilePaths[fileId];
              delete draft.fileDisplayNames[fileId];
              delete draft.filesLoading[fileId];
              delete draft.filesBandsPerOctave[fileId];
              delete draft.filesZoom[fileId];
              delete draft.filesOffset[fileId];
              delete draft.filesZoomY[fileId];
              delete draft.filesOffsetY[fileId];
              delete draft.filesPlaybackStartTime[fileId];
              delete draft.filesDirty[fileId];
            }),
          );
          const label = isManagedFilePath(filePath) ? "managed file" : truncateMiddle(host.path.basename(filePath), 50);
          notifications.show({
            title: "Failed to reopen file",
            message: `${label}: ${error instanceof Error ? error.message : ""}`,
            color: "red",
          });
        }
      }),
    );

    const after = get();
    if (after.activeFileId && openFiles[after.activeFileId]) {
      const file = openFiles[after.activeFileId];
      const transport = Tone.getTransport();
      const bpm = after.filepathsBpm[file.filePath];
      if (bpm) transport.bpm.value = bpm;
    }
  },
  filesPlaybackStartTime: {},
  setFilePlaybackStartTime: (fileId, time) =>
    set(
      produce((state: State) => {
        state.filesPlaybackStartTime[fileId] = time;
      }),
    ),
  filesLoopRegion: {},
  setFileLoopRegion: (fileId, region) =>
    set(
      produce((state: State) => {
        state.filesLoopRegion[fileId] = region;
      }),
    ),

  filesMuted: {},
  setFileMuted: (fileId, muted) => {
    set(
      produce((state: State) => {
        state.filesMuted[fileId] = muted;
      }),
    );
    get().applyLayerGains();
  },
  filesSoloed: {},
  setFileSoloed: (fileId, soloed) => {
    set(
      produce((state: State) => {
        state.filesSoloed[fileId] = soloed;
      }),
    );
    get().applyLayerGains();
  },
  filesVolumeDb: {},
  setFileVolumeDb: (fileId, volumeDb) => {
    set(
      produce((state: State) => {
        state.filesVolumeDb[fileId] = volumeDb;
      }),
    );
    get().applyLayerGains();
  },
  filesSelection: {},
  // The selection never writes the loop region; the time legend is the only
  // gesture that does.
  setFileSelection: (fileId, selection) => {
    set(
      produce((state: State) => {
        state.filesSelection[fileId] = selection;
      }),
    );
    get().retargetSelectionAudition(fileId);
  },
  filesDirty: {},
  setFileDirty: (fileId: string, dirty: boolean) => {
    set((state) => ({
      filesDirty: { ...state.filesDirty, [fileId]: dirty },
    }));
  },
  filesSynthesizing: {},
  setFileSynthesizing: (fileId: string, synthesizing: boolean) => {
    set((state) => ({
      filesSynthesizing: { ...state.filesSynthesizing, [fileId]: synthesizing },
    }));
  },
  filesLoading: {},
  filesBusy: {},
  setFileLoading: (fileId: string, message: string | undefined) => {
    set(
      produce((state: State) => {
        if (message === undefined) {
          delete state.filesLoading[fileId];
        } else {
          state.filesLoading[fileId] = message;
        }
      }),
    );
  },
  activeFileId: null,
  setActiveFileId: async (activeFileId) => {
    if (activeFileId && openFiles[activeFileId]) {
      const file = openFiles[activeFileId];
      const transport = Tone.getTransport();
      transport.bpm.value = get().filepathsBpm[file.filePath] ?? 120;

      if (file.audioBuffer) {
        transport.setLoopPoints(0, file.audioBuffer.duration);
      }

      // Layers of one group already sound together, so moving between them only
      // moves the paint target. Any other file is a different timeline, and
      // playback cannot carry across it.
      const previous = get().activeFileId;
      const staysInMix = previous !== null && selectStackLayerIds(get(), previous).includes(activeFileId);
      if (!staysInMix) get().stopAudio();
    }
    set({ activeFileId });
    if (activeFileId && openFiles[activeFileId]) {
      get().getPlayer();
      get().applyLayerGains();
    }
  },
  fullscreenFileId: null,
  setFullscreenFileId: (fileId) => set({ fullscreenFileId: fileId }),
  minimizedFileIds: [],
  setFileMinimized: (fileId, minimized) => {
    if (minimized) {
      const state = get();
      // Stop playback before minimizing
      if (state.isPlaying && state.activeFileId === fileId) {
        state.stopAudio();
      }
    } else {
      // Restoring a parked file is an admission, like opening it.
      const file = openFiles[fileId];
      if (file?.parked && file.spectrogramData) {
        const allowed = remainingCoefficientBudget(openFileTexelCounts(fileId));
        if (allowed !== undefined && file.spectrogramData.texels > allowed) {
          notifications.show({
            title: "Not enough graphics memory",
            message: "Close another file to free graphics memory, then restore this one.",
            color: "red",
          });
          return;
        }
      }
    }
    set(
      produce((state: State) => {
        if (minimized && !state.minimizedFileIds.includes(fileId)) {
          state.minimizedFileIds.push(fileId);
          if (state.activeFileId === fileId) {
            const lastVisible = [...state.openFileIds].reverse().find((id) => !state.minimizedFileIds.includes(id));
            state.activeFileId = lastVisible ?? null;
          }
        } else if (!minimized) {
          state.minimizedFileIds = state.minimizedFileIds.filter((id) => id !== fileId);
          state.activeFileId = fileId;
        }
      }),
    );
  },
  dropFile: (fileId, beforeFileId, stackId) => {
    set((state) => ({ openFileIds: reorderFileIds(state.openFileIds, fileId, beforeFileId) }));
    get().setLayerStack(fileId, stackId, get().openFileIds);
    // Membership just changed, so a group can have been left straddling another
    // file; each one closes back up into the single run its bracket draws over.
    set((state) => ({ openFileIds: gatherFileGroups(state.openFileIds, state.stackOfLayer) }));
  },
  openFileMinimized: async (filePath) => {
    // Check if already open
    const existing = Object.values(openFiles).find((f) => f.filePath === filePath);
    if (existing) {
      // Only collapse if it wasn't already open in the normal (non-minimized) file list
      if (!get().minimizedFileIds.includes(existing.id)) return;
      get().setFileMinimized(existing.id, true);
      return;
    }

    const state = get();
    const fileId = generateFileId();
    const displayName = host.path.basename(filePath);

    // Add placeholder and immediately minimize — never appears as a full canvas
    openFiles[fileId] = { id: fileId, filePath, displayName };
    set(
      produce((state: State) => {
        state.openFileIds.push(fileId);
        state.minimizedFileIds.push(fileId);
        state.filepathsBpm[filePath] ??= state.mostRecentBpm ?? 120;
        state.filesBandsPerOctave[fileId] = state.bandsPerOctave;
        state.filesZoom[fileId] = 0;
        state.filesOffset[fileId] = 0;
        state.filesZoomY[fileId] = 0;
        state.filesOffsetY[fileId] = 0;
        state.filesPlaybackStartTime[fileId] = 0;
        state.filesLoading[fileId] = "Analysing audio...";
        state.persistedFilePaths[fileId] = filePath;
        state.fileDisplayNames[fileId] = displayName;
      }),
    );

    try {
      await loadRealFileViaGaborator(fileId, filePath, state.bandsPerOctave, state.minFreq);
      set(
        produce((state: State) => {
          delete state.filesLoading[fileId];
        }),
      );
    } catch {
      delete openFiles[fileId];
      disposeOnsetTexture(fileId);
      set(
        produce((state: State) => {
          state.openFileIds = state.openFileIds.filter((id) => id !== fileId);
          state.minimizedFileIds = state.minimizedFileIds.filter((id) => id !== fileId);
          delete state.filesLoading[fileId];
        }),
      );
    }
  },
});
