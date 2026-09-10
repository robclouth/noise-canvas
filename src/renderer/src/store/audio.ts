import * as Tone from "tone";
import { listAudioOutputs, resolveOutputId, SYSTEM_DEFAULT_OUTPUT_ID, type AudioOutput } from "../lib/audio-devices";
import { diag } from "../lib/diag-log";
import { host } from "../lib/host";
import { clampPlaybackWindow, layerGain, type LayerMix, type PlaybackWindow } from "../lib/layer-mix";
import { selectMixFileIds } from "./file-groups";
import { activeLoopRegion, openFiles } from "./files";
import type { LoopRegion, PlayerClock, ZustandGet, ZustandSet } from "./types";

export interface AudioState {
  playerClock: PlayerClock;
  /** The active layer's player: the one the clock and the buffer swaps act on. */
  player: Tone.Player | null;
  meter: Tone.Meter | null;
  mixBus: Tone.Gain | null;
  /** The bus every layer's gain feeds. The meter reads it, so it shows the mix. */
  getMixBus: () => Tone.Gain;
  /** Pushes every layer's mute, solo and volume onto the running mix. */
  applyLayerGains: () => void;
  /** Position the player is at, at `atTime` on the audio clock (default now). */
  getPlaybackTime: (atTime?: number) => number;
  getPlayer: () => Tone.Player;
  getOutputLevels: () => [number, number];
  isPlaying: boolean;
  setIsPlaying: (isPlaying: boolean) => void;
  loop: boolean;
  setLoop: (loop: boolean) => void;
  autoPlayStroke: boolean;
  setAutoPlayStroke: (value: boolean) => void;
  limiterEnabled: boolean;
  reanalyzeStrokes: boolean;
  /** Sets the active file's loop region. */
  setLoopRegion: (region: LoopRegion | null) => void;
  setPlaybackTime: (playbackTime: number, atTime?: number) => void;
  /**
   * Put `audioBuffer` under the running player at the position it already
   * plays, crossfading out of the buffer it replaces.
   */
  swapPlayingBuffer: (audioBuffer: AudioBuffer) => void;
  /** Swaps without the selection-audition re-mask; the audition path itself calls this. */
  swapPlayingBufferRaw: (audioBuffer: AudioBuffer) => void;
  togglePlayback: () => Promise<void>;
  stopAudio: () => void;

  /** Output playback is routed to, or `SYSTEM_DEFAULT_OUTPUT_ID` to follow the system. */
  outputDeviceId: string;
  /** Name the chosen output was last seen under, which re-finds it after a reconnect. */
  outputDeviceLabel: string;
  /** Routes playback to `device`, or to the system's own output when it is null. */
  setOutputDevice: (device: AudioOutput | null) => Promise<void>;
  /** Points the audio context at the chosen output, falling back to the system's. */
  applyOutputDevice: () => Promise<void>;
}

export const AUDIO_PERSISTED_KEYS = [
  "autoPlayStroke",
  "loop",
  "limiterEnabled",
  "reanalyzeStrokes",
  "outputDeviceId",
  "outputDeviceLabel",
] as const;

// Fade on every source the player makes, so a restart overlaps the outgoing and
// incoming sources into a crossfade rather than a hard splice. Tone copies it
// onto a source when it is made, so it must be set before playback starts —
// setting it later leaves the outgoing source stopping dead.
const PLAYER_FADE_SEC = 0.01;

// Seconds a gain change takes, so a mute or a volume drag does not click.
const GAIN_RAMP_SEC = 0.01;

/** One layer's way into the mix: its own player, behind its own gain. */
interface LayerVoice {
  player: Tone.Player;
  gain: Tone.Gain;
}

// A voice per layer, made on demand. The active layer's player is also held in
// state as `player`, which is what the clock, the buffer swaps and the selection
// audition act on.
const layerVoices = new Map<string, LayerVoice>();

// True while a buffer hot-swap restarts the active layer. A commit replaces one
// layer's audio, so restarting the rest of the mix here would click every other
// layer on every stroke.
let holdOtherLayers = false;

function mixOf(state: {
  filesMuted: Record<string, boolean>;
  filesSoloed: Record<string, boolean>;
  filesVolumeDb: Record<string, number>;
}): LayerMix {
  return { muted: state.filesMuted, soloed: state.filesSoloed, volumeDb: state.filesVolumeDb };
}

function disposeVoice(fileId: string): void {
  const voice = layerVoices.get(fileId);
  if (!voice) return;
  voice.player.stop();
  voice.player.dispose();
  voice.gain.dispose();
  layerVoices.delete(fileId);
}

/** Drops every layer's player and gain, leaving the mix bus in place. */
export function releaseLayerVoices(): void {
  releaseVoices();
}

/** Drops every voice except the ones named, which a change of stack leaves behind. */
function releaseVoices(keep?: Set<string>): void {
  for (const fileId of [...layerVoices.keys()]) {
    if (keep?.has(fileId)) continue;
    disposeVoice(fileId);
  }
}

function getVoice(get: ZustandGet, fileId: string): LayerVoice {
  const existing = layerVoices.get(fileId);
  if (existing) return existing;

  const gain = new Tone.Gain(1).connect(get().getMixBus());
  const player = new Tone.Player({
    loop: false,
    autostart: false,
    fadeIn: PLAYER_FADE_SEC,
    fadeOut: PLAYER_FADE_SEC,
  }).connect(gain);

  // Restarting stops the outgoing source, so this fires for a buffer hot-swap
  // or a scrub as well as for the end of the file. Only the end leaves no
  // source running, and only the active layer's end stops the transport: a
  // shorter layer running out must not take the rest of the mix with it.
  player.onstop = () => {
    const { loop, isPlaying, player: active } = get();
    if (isPlaying && !loop && active === player && player.state !== "started") {
      get().stopAudio();
    }
  };

  const voice: LayerVoice = { player, gain };
  layerVoices.set(fileId, voice);
  return voice;
}

/**
 * Puts every other layer of the active stack under the same clock as the active
 * one: a single start time, offset, rate and pair of loop points.
 */
function startOtherLayers(
  get: ZustandGet,
  atTime: number,
  offset: number,
  window: PlaybackWindow,
  loop: boolean,
  rate: number,
): void {
  if (holdOtherLayers) return;
  const state = get();
  const { activeFileId } = state;
  if (!activeFileId) return;

  const ids = selectMixFileIds(state, activeFileId);
  releaseVoices(new Set(ids));

  const mix = mixOf(state);
  layerVoices.get(activeFileId)?.gain.gain.setValueAtTime(layerGain(mix, ids, activeFileId), atTime);

  for (const fileId of ids) {
    if (fileId === activeFileId) continue;
    const buffer = openFiles[fileId]?.audioBuffer;
    if (!buffer) continue;

    const voice = getVoice(get, fileId);
    if (voice.player.buffer.get() !== buffer) voice.player.buffer = new Tone.ToneAudioBuffer(buffer);
    voice.gain.gain.setValueAtTime(layerGain(mix, ids, fileId), atTime);
    voice.player.playbackRate = rate;

    const started = voice.player.state === "started";
    // A layer too short to cover a looped window would loop at its own end and
    // walk away from the rest, so it plays through once instead.
    if (loop && buffer.duration >= window.end) {
      voice.player.loop = true;
      voice.player.loopStart = window.start;
      voice.player.loopEnd = window.end;
      if (started) voice.player.restart(atTime, offset);
      else voice.player.start(atTime, offset);
      continue;
    }

    voice.player.loop = false;
    const span = Math.min(window.end, buffer.duration) - offset;
    if (span <= 0) {
      voice.player.stop(atTime);
    } else if (started) {
      voice.player.restart(atTime, offset, span);
    } else {
      voice.player.start(atTime, offset, span);
    }
  }
}

// False until the log carries a line for where playback goes. The first apply
// writes one even when it changes nothing; later ones write only on a change.
let outputRouteLogged = false;

export const createAudioSlice = (set: ZustandSet, get: ZustandGet): AudioState => ({
  player: null,
  meter: null,
  mixBus: null,
  playerClock: {
    startAt: null,
    startOffset: 0,
    loopStart: 0,
    loopEnd: 0,
  },

  getPlaybackTime: (atTime) => {
    const { player, isPlaying, loop, activeFileId, playerClock, filesLoopRegion } = get();
    const loopRegion = activeLoopRegion({ activeFileId, filesLoopRegion });
    const file = activeFileId ? openFiles[activeFileId] : undefined;
    const buffer = file?.audioBuffer;
    if (!player || !buffer) return 0;

    const end = loopRegion?.end ?? buffer.duration;

    if (!isPlaying || playerClock.startAt === null) {
      return Math.min(Math.max(playerClock.startOffset, playerClock.loopStart), end);
    }

    const now = atTime ?? Tone.now();
    const elapsed = Math.max(0, now - playerClock.startAt);
    const rate = player.playbackRate ?? 1;
    let pos = playerClock.startOffset + elapsed * rate;

    if (loop) {
      // The clock's own window: a selection audition loops a span no stored
      // loop region describes.
      const L0 = playerClock.loopStart;
      const L1 = playerClock.loopEnd;
      const len = Math.max(0, L1 - L0);
      if (len <= 0) return L1;
      const delta = pos - L0;
      pos = L0 + (delta - Math.floor(delta / len) * len);
      if (pos >= L1) pos = L0;
    } else {
      if (pos > end) pos = end;
    }
    return pos;
  },

  getOutputLevels: () => {
    const meter = get().meter;
    if (!meter) return [-Infinity, -Infinity];
    const value = meter.getValue();
    if (Array.isArray(value)) {
      const left = value[0] ?? -Infinity;
      const right = value[1] ?? left;
      // Mono sources only feed channel 0, so mirror it onto the right bar.
      return [left, right === -Infinity && left !== -Infinity ? left : right];
    }
    return [value, value];
  },

  getMixBus: () => {
    const existing = get().mixBus;
    if (existing) return existing;

    const bus = new Tone.Gain(1).toDestination();
    // Fan the mix out to a stereo meter for the transport level display.
    const meter = new Tone.Meter({ channelCount: 2, normalRange: false, smoothing: 0.8 });
    bus.connect(meter);
    set({ mixBus: bus, meter });
    return bus;
  },

  getPlayer: () => {
    // With no file open the voice is keyed on the empty id, and plays nothing.
    const voice = getVoice(get, get().activeFileId ?? "");
    if (get().player !== voice.player) set({ player: voice.player });
    return voice.player;
  },

  applyLayerGains: () => {
    const state = get();
    const { activeFileId } = state;
    if (!activeFileId) return;

    const ids = selectMixFileIds(state, activeFileId);
    const mix = mixOf(state);
    for (const [fileId, voice] of layerVoices) {
      // A voice left over from another stack is on its way out; hold it down.
      const gain = ids.includes(fileId) ? layerGain(mix, ids, fileId) : 0;
      voice.gain.gain.rampTo(gain, GAIN_RAMP_SEC);
    }
  },

  isPlaying: false,
  setIsPlaying: (isPlaying) => set({ isPlaying }),

  loop: false,
  setLoop: (loop) => {
    const { player, isPlaying, activeFileId, getPlaybackTime, filesLoopRegion } = get();
    const loopRegion = activeLoopRegion({ activeFileId, filesLoopRegion });
    const file = activeFileId ? openFiles[activeFileId] : undefined;
    const buffer = file?.audioBuffer;

    if (!isPlaying || !player || !buffer) {
      set({ loop });
      return;
    }

    // One clock reading for the restart and for every other layer, so the whole
    // mix lands on the same instant.
    const now = Tone.now();
    const currentTime = getPlaybackTime(now);
    set({ loop });
    const window = clampPlaybackWindow(loopRegion, buffer.duration);

    player.loop = loop;

    if (loop) {
      player.loopStart = window.start;
      player.loopEnd = window.end;
      player.restart(now, currentTime);
    } else {
      const remainingDuration = Math.max(0, window.end - currentTime);
      player.restart(now, currentTime, remainingDuration);
    }

    startOtherLayers(get, now, currentTime, window, loop, player.playbackRate ?? 1);

    set((s) => ({
      playerClock: {
        ...s.playerClock,
        startAt: now,
        startOffset: currentTime,
        loopStart: window.start,
        loopEnd: window.end,
      },
    }));
  },

  autoPlayStroke: false,
  setAutoPlayStroke: (value) => set({ autoPlayStroke: value }),

  // Whether painting holds each stroke's own level down. Read at mouse-up and
  // baked into the stroke, so changing it only affects what is painted next.
  limiterEnabled: true,

  // Whether a committed stroke is redrawn from the analysis of its own audio.
  // Read at mouse-up, like the limiter; the audio is the same either way.
  reanalyzeStrokes: false,

  setLoopRegion: (region) => {
    const { activeFileId, setFileLoopRegion } = get();
    if (!activeFileId) return;
    setFileLoopRegion(activeFileId, region);

    if (!region) return;

    const { player, isPlaying } = get();
    if (!isPlaying || !player) return;

    const file = activeFileId ? openFiles[activeFileId] : undefined;
    const buffer = file?.audioBuffer;
    if (!buffer) return;

    const now = Tone.now();
    const window = clampPlaybackWindow(region, buffer.duration);

    set({ loop: true });
    player.loop = true;
    player.loopStart = window.start;
    player.loopEnd = window.end;
    player.restart(now, window.start);

    startOtherLayers(get, now, window.start, window, true, player.playbackRate ?? 1);

    set((s) => ({
      playerClock: {
        ...s.playerClock,
        startAt: now,
        startOffset: window.start,
        loopStart: window.start,
        loopEnd: window.end,
      },
    }));
  },

  setPlaybackTime: (playbackTime, atTime) => {
    const { activeFileId, loop, getPlayer, filesLoopRegion } = get();
    const loopRegion = activeLoopRegion({ activeFileId, filesLoopRegion });
    if (activeFileId === null) return;
    const file = openFiles[activeFileId];
    const buf = file?.audioBuffer;
    if (!buf) return;

    const player = getPlayer();
    const startAt = atTime ?? Tone.now();
    const window = clampPlaybackWindow(loopRegion, buf.duration);
    const offset = Math.min(Math.max(playbackTime, 0), window.end);

    set((s) => ({
      playerClock: {
        ...s.playerClock,
        startAt,
        startOffset: offset,
        loopStart: window.start,
        loopEnd: window.end,
      },
    }));

    if (player.state === "started") {
      if (loop) {
        player.loop = true;
        player.loopStart = window.start;
        player.loopEnd = window.end;
        player.restart(startAt, offset);
      } else {
        player.loop = false;
        player.restart(startAt, offset, Math.max(0, window.end - offset));
      }
      startOtherLayers(get, startAt, offset, window, loop, player.playbackRate ?? 1);
    }
  },

  swapPlayingBuffer: (audioBuffer) => {
    // While a selection auditions itself, a commit's fresh audio is re-masked
    // before it reaches the running player, so the mask survives painting.
    if (get().selectionAudition) {
      get().remaskPlayingBuffer(audioBuffer);
      return;
    }
    get().swapPlayingBufferRaw(audioBuffer);
  },

  swapPlayingBufferRaw: (audioBuffer) => {
    const { getPlayer, getPlaybackTime, setPlaybackTime } = get();
    // One clock reading for both the position and the restart, so the incoming
    // source lines up with the outgoing one it fades across.
    const now = Tone.now();
    const player = getPlayer();
    const playbackTime = getPlaybackTime(now);
    player.buffer = new Tone.ToneAudioBuffer(audioBuffer);
    player.volume.value = 0;
    holdOtherLayers = true;
    try {
      setPlaybackTime(playbackTime, now);
    } finally {
      holdOtherLayers = false;
    }
  },

  togglePlayback: async () => {
    const state = get();
    const { isPlaying, activeFileId, loop, filesPlaybackStartTime, getPlayer } = state;
    const loopRegion = activeLoopRegion(state);

    if (!activeFileId) {
      return;
    }

    if (isPlaying) {
      return state.stopAudio();
    }

    const file = openFiles[activeFileId];
    const buffer = file?.audioBuffer;
    if (!buffer) {
      console.error("No audio buffer available to play.");
      return;
    }

    if (Tone.getContext().rawContext.state !== "running") {
      await Tone.start();
    }

    // A selection auditions itself: its own bands, over its own stretch of
    // time. A full-height selection needs no masking, only the window.
    const selection = state.filesSelection[activeFileId] ?? null;
    let playBuffer = buffer;
    if (selection) {
      const masked = await get().selectionAuditionBuffer(activeFileId, selection);
      if (masked) playBuffer = masked;
      set({ selectionAudition: masked !== null });
    } else if (state.selectionAudition) {
      set({ selectionAudition: false });
    }
    const region = selection ? { start: selection.start, end: selection.end } : loopRegion;

    const player = getPlayer();
    player.buffer = new Tone.ToneAudioBuffer(playBuffer);
    player.volume.value = 0;

    // The buffer bounds the window: a region measured against an older, longer
    // file cannot push the loop points past the end.
    const window = clampPlaybackWindow(region, playBuffer.duration);
    const { start: loopStart, end } = window;

    // When Link is enabled and active, phase-align and adjust playback rate
    const { linkEnabled, linkTempo, linkQuantum, filepathsBpm, linkLatencyMs } = get();
    const linkActive = linkEnabled && typeof window !== "undefined" && host.link?.isEnabled?.();

    if (linkActive) {
      const fileBpm = filepathsBpm[file.filePath] ?? 120;
      player.playbackRate = linkTempo / fileBpm;

      if (loop) {
        player.loop = true;
        player.loopStart = loopStart;
        player.loopEnd = end;
      } else {
        player.loop = false;
      }

      try {
        const ctx = Tone.getContext().rawContext;
        const linkState = host.link.captureState(linkQuantum);
        const actualTempo = linkState.tempo;
        const rate = actualTempo / fileBpm;
        player.playbackRate = rate;

        // Add latency as a simple beat offset
        const latencyBeats = (linkLatencyMs / 1000) * (actualTempo / 60);
        const adjustedBeat = linkState.beat + latencyBeats;

        const secondsPerBeat = 60 / fileBpm;

        // A zero-length span makes the modulo below NaN, and a NaN offset
        // reaches player.start. Fall through to the normal, unsynced start.
        const spanSeconds = loop && region ? region.end - region.start : playBuffer.duration;
        if (!(spanSeconds > 0) || !Number.isFinite(secondsPerBeat) || secondsPerBeat <= 0) {
          throw new Error("Link sync needs a non-empty span and a positive tempo");
        }

        let offset: number;
        if (loop && region) {
          const loopLenBeats = spanSeconds / secondsPerBeat;
          const posInLoopBeats = ((adjustedBeat % loopLenBeats) + loopLenBeats) % loopLenBeats;
          offset = region.start + posInLoopBeats * secondsPerBeat;
        } else {
          const durationBeats = spanSeconds / secondsPerBeat;
          const posBeats = ((adjustedBeat % durationBeats) + durationBeats) % durationBeats;
          offset = posBeats * secondsPerBeat;
        }

        const startTime = ctx.currentTime + 0.001;
        if (loop) {
          player.start(startTime, offset);
        } else {
          player.start(startTime, offset, Math.max(0, end - offset));
        }

        startOtherLayers(get, startTime, offset, window, loop, rate);

        return set({
          isPlaying: true,
          player,
          playerClock: {
            startAt: Tone.now(),
            startOffset: offset,
            loopStart,
            loopEnd: end,
          } as PlayerClock,
        });
      } catch {
        // Link not ready, fall through to normal start
      }
    }

    // The play marker starts playback only when it sits inside the window a
    // selection scopes; from anywhere else the selection plays from its start.
    const startTime = filesPlaybackStartTime[activeFileId];
    const marker = region && !(startTime >= region.start && startTime < region.end) ? region.start : startTime;
    const offset = Math.min(Math.max(marker, 0), end);

    // One clock reading for every layer, so the mix starts together.
    const startAt = Tone.now();
    if (loop) {
      player.loop = true;
      player.loopStart = loopStart;
      player.loopEnd = end;
      player.start(startAt, offset);
    } else {
      player.loop = false;
      player.start(startAt, offset, Math.max(0, end - offset));
    }

    startOtherLayers(get, startAt, offset, window, loop, player.playbackRate ?? 1);

    return set({
      isPlaying: true,
      player,
      playerClock: {
        startAt,
        startOffset: offset,
        loopStart,
        loopEnd: end,
      } as PlayerClock,
    });
  },

  outputDeviceId: SYSTEM_DEFAULT_OUTPUT_ID,
  outputDeviceLabel: "",

  setOutputDevice: async (device) => {
    set({
      outputDeviceId: device?.id ?? SYSTEM_DEFAULT_OUTPUT_ID,
      outputDeviceLabel: device?.label ?? "",
    });
    await get().applyOutputDevice();
  },

  applyOutputDevice: async () => {
    const context = Tone.getContext().rawContext;
    if (!("setSinkId" in context)) return;

    const { outputDeviceId, outputDeviceLabel } = get();
    let target = SYSTEM_DEFAULT_OUTPUT_ID;
    let connected = true;

    if (outputDeviceId !== SYSTEM_DEFAULT_OUTPUT_ID) {
      const resolved = resolveOutputId(await listAudioOutputs(), outputDeviceId, outputDeviceLabel);
      connected = resolved !== null;
      if (resolved !== null) {
        target = resolved;
        // The chosen output kept its name but came back under a new id.
        if (resolved !== outputDeviceId) set({ outputDeviceId: resolved });
      }
    }

    const changing = context.sinkId !== target;
    if (!changing && outputRouteLogged) return;

    try {
      if (changing) await context.setSinkId(target);
      outputRouteLogged = true;
      const route = {
        label: outputDeviceLabel || "system default",
        sampleRate: context.sampleRate,
        channels: context.destination.maxChannelCount,
      };
      if (connected) diag.info("audio", "playback output", route);
      else diag.warn("audio", "playback output, chosen device not connected", route);
    } catch (error) {
      diag.error("audio", "output device refused", {
        label: outputDeviceLabel,
        error: String(error),
      });
    }
  },

  stopAudio: () => {
    const { activeFileId, filesPlaybackStartTime } = get();

    if (!activeFileId) {
      return;
    }

    for (const voice of layerVoices.values()) voice.player.stop();
    // The active layer's voice stays, because `player` points at it.
    releaseVoices(new Set([activeFileId]));

    set((s) => ({
      isPlaying: false,
      selectionAudition: false,
      playerClock: {
        ...s.playerClock,
        startAt: null,
        startOffset: filesPlaybackStartTime[activeFileId],
      },
    }));
  },
});
