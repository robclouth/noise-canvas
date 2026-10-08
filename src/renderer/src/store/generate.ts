import { notifications } from "@mantine/notifications";
import { produce } from "immer";
import type { AnalysisParams } from "../../../main/lib/types";
import type { GenerateSettings } from "../components/generate-fields";
import { serializeEditCommand } from "../lib/file-task-queue";
import { remainingCoefficientBudget } from "../lib/gpu-budget";
import { host } from "../lib/host";
import { openGeneratePrompt } from "../lib/modals";
import { PackedSpan } from "../lib/packed-span";
import { resampleChannels } from "../lib/resample";
import { isFullHeight, selectionBandRange, type Selection } from "../lib/selection";
import { buildClipboardRegion } from "../lib/selection-clip";
import {
  currentFileChannels,
  openFiles,
  openFileTexelCounts,
  rebuildFileFromCurrentAudio,
  spectrogramFromAnalysis,
} from "./files";
import { pasteRegionInto } from "./selection-clipboard";
import type { SpectrogramData, State, ZustandGet, ZustandSet } from "./types";

/** Seconds of the file either side of a selection that the model hears. */
const CONTEXT_SECONDS = 10;
/** How long the model stays in memory after a Generate. */
const RELEASE_AFTER_MS = 5 * 60 * 1000;
const LABEL = "Generate";
const DOWNLOAD_NOTIFICATION = "generate-model-download";

export interface GenerateState {
  /** Asks for a prompt, then generates into the active file's selection, or over the whole file. */
  promptGenerate: () => Promise<void>;
  /** Generates into the active file's selection, or over the whole file when nothing is selected, as one edit. */
  generateIntoActiveFile: (settings: GenerateSettings) => Promise<void>;
}

let releaseTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleRelease(): void {
  if (releaseTimer) clearTimeout(releaseTimer);
  releaseTimer = setTimeout(() => {
    releaseTimer = null;
    host.analysis.releaseGenerateModels?.();
  }, RELEASE_AFTER_MS);
}

/** The Hz range a band-limited selection covers, out to the edges of its outer bands. */
function selectionHz(selection: Selection, spec: SpectrogramData): { loHz: number; hiHz: number } {
  const { lowBand, highBand } = selectionBandRange(selection, spec.numBands);
  const halfBand = 2 ** (0.5 / spec.bandsPerOctave);
  return { loHz: spec.metadata[highBand * 4 + 3] / halfBand, hiHz: spec.metadata[lowBand * 4 + 3] * halfBand };
}

async function ensureModel(): Promise<boolean> {
  if (host.analysis.isGenerateModelDownloaded?.()) return true;
  const download = host.analysis.downloadGenerateModel;
  if (!download) return false;
  notifications.show({
    id: DOWNLOAD_NOTIFICATION,
    title: "Downloading the Generate model",
    message: "Starting download…",
    color: "blue",
    loading: true,
    autoClose: false,
  });
  try {
    await download((done, total) => {
      const gb = (bytes: number) => (bytes / 1024 ** 3).toFixed(2);
      notifications.update({
        id: DOWNLOAD_NOTIFICATION,
        title: "Downloading the Generate model",
        message: `${Math.round((done / total) * 100)}%  (${gb(done)} / ${gb(total)} GB)`,
        color: "blue",
        loading: true,
        autoClose: false,
      });
    });
    notifications.update({
      id: DOWNLOAD_NOTIFICATION,
      title: "Generate model ready",
      message: "Model downloaded.",
      color: "green",
      loading: false,
      autoClose: 3000,
    });
    return true;
  } catch (error) {
    notifications.update({
      id: DOWNLOAD_NOTIFICATION,
      title: "Model download failed",
      message: error instanceof Error ? error.message : String(error),
      color: "red",
      loading: false,
      autoClose: 5000,
    });
    return false;
  }
}

/** `channels` cut or padded with silence to `length` frames. */
function toLength(channels: Float32Array[], length: number): Float32Array[] {
  return channels.map((channel) => {
    if (channel.length === length) return channel;
    const out = new Float32Array(length);
    out.set(channel.subarray(0, length));
    return out;
  });
}

/** The take as a clipboard region laid out on the file's own bands, cut to `rect` in the take's time. */
async function takeRegion(take: Float32Array[], spec: SpectrogramData, rect: Selection, name: string) {
  const params: AnalysisParams = {
    bandsPerOctave: spec.bandsPerOctave,
    minFreq: spec.minFreq,
    maxCoefficients: remainingCoefficientBudget(openFileTexelCounts()),
    detectOnsets: false,
  };
  const buffer = new AudioBuffer({
    length: take[0].length,
    numberOfChannels: take.length,
    sampleRate: spec.sampleRate,
  });
  take.forEach((channel, ch) => buffer.copyToChannel(new Float32Array(channel), ch));
  const takeSpec = await spectrogramFromAnalysis(await host.analysis.analyseBuffer(buffer, params), params);
  return buildClipboardRegion(PackedSpan.whole(takeSpec, takeSpec.packedData), rect, takeSpec, name);
}

export const createGenerateSlice = (set: ZustandSet, get: ZustandGet): GenerateState => ({
  promptGenerate: async () => {
    const fileId = get().activeFileId;
    const file = fileId ? openFiles[fileId] : undefined;
    if (!fileId || !file?.spectrogramData) {
      notifications.show({ title: "Nothing to generate into", message: "Open a file first.", color: "yellow" });
      return;
    }
    if (!host.analysis.generateAvailable?.()) {
      notifications.show({
        title: "Generate is not available",
        message: "It needs an Apple Silicon Mac on macOS 14 or newer, Windows or Linux.",
        color: "yellow",
      });
      return;
    }
    const selection = get().filesSelection[fileId] ?? null;
    const confirmed = await new Promise<boolean>((resolve) => {
      let done = false;
      openGeneratePrompt({
        hasSelection: selection !== null,
        bandLimited: selection !== null && !isFullHeight(selection),
        onConfirm: () => {
          done = true;
          resolve(true);
        },
        onCancel: () => resolve(false),
        onClose: () => {
          if (!done) resolve(false);
        },
      });
    });
    if (!confirmed) return;
    const { generatePrompt, generateStrength, generateInput } = get();
    const settings: GenerateSettings = {
      prompt: generatePrompt,
      strength: generateStrength / 100,
      input: generateInput,
    };
    await get().generateIntoActiveFile(settings);
  },

  generateIntoActiveFile: (settings) =>
    serializeEditCommand(async () => {
      const fileId = get().activeFileId;
      const file = fileId ? openFiles[fileId] : undefined;
      const spec = file?.spectrogramData;
      if (!fileId || !file || !spec) return;
      if (get().filesLoading[fileId] || get().filesBusy[fileId]) return;
      if (!host.analysis.generate || !(await ensureModel())) return;

      const setBusy = (message: string) =>
        set(
          produce((state: State) => {
            state.filesBusy[fileId] = message;
          }),
        );
      const clearBusy = () =>
        set(
          produce((state: State) => {
            delete state.filesBusy[fileId];
          }),
        );

      const selection = get().filesSelection[fileId] ?? null;
      const duration = spec.numFrames / spec.sampleRate;
      const strength = Math.min(1, Math.max(0.05, settings.strength));
      setBusy("Loading the model…");
      try {
        const audio = await currentFileChannels(fileId);
        if (!audio) throw new Error("Could not read the file's audio.");
        const { sampleRate } = audio;
        const contextStart = selection ? Math.max(0, selection.start - CONTEXT_SECONDS) : 0;
        const contextEnd = selection ? Math.min(duration, selection.end + CONTEXT_SECONDS) : duration;
        const from = Math.round(contextStart * sampleRate);
        const to = Math.min(audio.channels[0].length, Math.round(contextEnd * sampleRate));
        const modelRate = host.analysis.GENERATE_SAMPLE_RATE ?? 44100;
        const original = await resampleChannels(
          audio.channels.map((channel) => channel.slice(from, to)),
          sampleRate,
          modelRate,
        );
        const params: AnalysisParams = { bandsPerOctave: spec.bandsPerOctave, minFreq: spec.minFreq };

        const bands = selection && !isFullHeight(selection) ? selectionHz(selection, spec) : null;
        let context = original;
        if (bands && settings.input === "selection" && host.analysis.bandLimit) {
          context = await host.analysis.bandLimit(original, modelRate, params, bands);
        }

        const span: [number, number] | undefined = selection
          ? [selection.start - contextStart, selection.end - contextStart]
          : undefined;
        let take = await host.analysis.generate(
          { prompt: settings.prompt, context, strength, fill: strength >= 1 ? span : undefined },
          (step, steps) =>
            setBusy(step === 0 ? "Generating…" : step >= steps ? "Finishing…" : `Generating… ${step}/${steps}`),
        );
        scheduleRelease();
        if (strength < 1 && host.analysis.matchLevel) {
          take = await host.analysis.matchLevel(take, original, modelRate, params, {
            loHz: bands?.loHz ?? 0,
            hiHz: bands?.hiHz ?? Infinity,
            start: span?.[0],
            end: span?.[1],
          });
        }
        take = toLength(await resampleChannels(take, modelRate, sampleRate), to - from);

        if (!selection) {
          await rebuildFileFromCurrentAudio(set, fileId, () => take, { kind: "reanalyze", label: LABEL }, clearBusy);
          return;
        }
        const rect = { ...selection, start: selection.start - contextStart, end: selection.end - contextStart };
        const region = await takeRegion(take, { ...spec, sampleRate }, rect, file.displayName);
        if (!region) throw new Error("The selection holds no bands to write.");
        clearBusy();
        await pasteRegionInto(get, fileId, region, selection, LABEL);
      } catch (error) {
        console.error("Generate failed:", error);
        notifications.show({
          title: "Generate failed",
          message: error instanceof Error ? error.message : "Unknown error",
          color: "red",
        });
      } finally {
        clearBusy();
      }
    }),
});
