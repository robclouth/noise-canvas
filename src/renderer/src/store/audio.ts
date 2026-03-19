import * as Tone from "tone";
import { openFiles } from "./files";
import type { LoopRegion, PlayerClock, ZustandGet, ZustandSet } from "./types";

export interface AudioState {
  playerClock: PlayerClock;
  player: Tone.Player | null;
  getPlaybackTime: () => number;
  getPlayer: () => Tone.Player;
  isPlaying: boolean;
  setIsPlaying: (isPlaying: boolean) => void;
  loop: boolean;
  setLoop: (loop: boolean) => void;
  autoPlayStroke: boolean;
  setAutoPlayStroke: (value: boolean) => void;
  loopRegion: LoopRegion | null;
  setLoopRegion: (region: LoopRegion | null) => void;
  setPlaybackTime: (playbackTime: number) => void;
  togglePlayback: () => Promise<void>;
  stopAudio: () => void;
}

export const AUDIO_PERSISTED_KEYS = ["autoPlayStroke", "loop"] as const;

export const createAudioSlice = (set: ZustandSet, get: ZustandGet): AudioState => ({
  player: null,
  playerClock: {
    startAt: null,
    startOffset: 0,
    loopStart: 0,
    loopEnd: 0,
  },

  getPlaybackTime: () => {
    const { player, isPlaying, loop, loopRegion, activeFileId, playerClock } = get();
    const file = activeFileId ? openFiles[activeFileId] : undefined;
    const buffer = file?.audioBuffer;
    if (!player || !buffer) return 0;

    const end = loopRegion?.end ?? buffer.duration;

    if (!isPlaying || playerClock.startAt === null) {
      return Math.min(Math.max(playerClock.startOffset, playerClock.loopStart), end);
    }

    const now = Tone.now();
    const elapsed = Math.max(0, now - playerClock.startAt);
    let pos = playerClock.startOffset + elapsed;

    if (loop) {
      const L0 = loopRegion?.start ?? 0;
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

  getPlayer: () => {
    const p = get().player;
    if (p) return p;

    const newPlayer = new Tone.Player({
      loop: false,
      autostart: false,
      fadeIn: 0,
      fadeOut: 0,
    }).toDestination();

    newPlayer.onstop = () => {
      const { loop, getPlaybackTime, isPlaying, playerClock } = get();
      if (isPlaying) {
        const t = getPlaybackTime();
        const end = playerClock.loopEnd;
        if (!loop && t >= end - 0.01) {
          get().stopAudio();
        }
      }
    };

    set({ player: newPlayer });
    return newPlayer;
  },

  isPlaying: false,
  setIsPlaying: (isPlaying) => set({ isPlaying }),

  loop: false,
  setLoop: (loop) => {
    const { player, isPlaying, loopRegion, activeFileId, getPlaybackTime } = get();
    const file = activeFileId ? openFiles[activeFileId] : undefined;
    const buffer = file?.audioBuffer;

    if (!isPlaying || !player || !buffer) {
      set({ loop });
      return;
    }

    const currentTime = getPlaybackTime();
    set({ loop });
    const end = loopRegion?.end ?? buffer.duration;
    const loopStart = loopRegion?.start ?? 0;

    player.loop = loop;

    if (loop) {
      player.loopStart = loopStart;
      player.loopEnd = end;
      player.restart(Tone.now(), currentTime);
    } else {
      const remainingDuration = Math.max(0, end - currentTime);
      player.restart(Tone.now(), currentTime, remainingDuration);
    }

    set((s) => ({
      playerClock: {
        ...s.playerClock,
        startAt: Tone.now(),
        startOffset: currentTime,
        loopStart,
        loopEnd: end,
      },
    }));
  },

  autoPlayStroke: false,
  setAutoPlayStroke: (value) => set({ autoPlayStroke: value }),

  loopRegion: null,
  setLoopRegion: (region) => {
    set({ loopRegion: region });

    if (!region) return;

    const { player, isPlaying, getPlayer, activeFileId } = get();
    if (!isPlaying || !player) return;

    const file = activeFileId ? openFiles[activeFileId] : undefined;
    const buffer = file?.audioBuffer;
    if (!buffer) return;

    const loopStart = region.start;
    const loopEnd = region.end;

    set({ loop: true });
    player.loop = true;
    player.loopStart = loopStart;
    player.loopEnd = loopEnd;
    player.restart(Tone.now(), loopStart);

    set((s) => ({
      playerClock: {
        ...s.playerClock,
        startAt: Tone.now(),
        startOffset: loopStart,
        loopStart,
        loopEnd,
      },
    }));
  },

  setPlaybackTime: (playbackTime) => {
    const { activeFileId, loopRegion, loop, getPlayer } = get();
    if (activeFileId === null) return;
    const file = openFiles[activeFileId];
    const buf = file?.audioBuffer;
    if (!buf) return;

    const player = getPlayer();
    const end = loopRegion?.end ?? buf.duration;
    const loopStart = loopRegion?.start ?? 0;
    const offset = Math.min(Math.max(playbackTime, 0), end);

    set((s) => ({
      playerClock: {
        ...s.playerClock,
        startAt: Tone.now(),
        startOffset: offset,
        loopStart,
        loopEnd: end,
      },
    }));

    if (player.state === "started") {
      if (loop) {
        player.loop = true;
        player.loopStart = loopStart;
        player.loopEnd = end;
        player.restart(Tone.now(), offset);
      } else {
        player.loop = false;
        player.restart(Tone.now(), offset, Math.max(0, end - offset));
      }
    }
  },

  togglePlayback: async () => {
    const state = get();
    const { isPlaying, activeFileId, loop, filesPlaybackStartTime, loopRegion, getPlayer } = state;

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

    const player = getPlayer();
    player.buffer = new Tone.ToneAudioBuffer(buffer);

    const peak = file?.audioPeak ?? 1;
    const normalize = get().normalize;
    player.volume.value = normalize && peak > 0 ? Tone.gainToDb(1 / peak) : 0;

    const startTime = filesPlaybackStartTime[activeFileId];
    const end = loopRegion?.end ?? buffer.duration;
    const loopStart = loopRegion?.start ?? 0;
    const offset = Math.min(Math.max(startTime, 0), end);

    if (loop) {
      player.loop = true;
      player.loopStart = loopStart;
      player.loopEnd = end;
      player.start(Tone.now(), offset);
    } else {
      player.loop = false;
      player.start(Tone.now(), offset, Math.max(0, end - offset));
    }

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
  },

  stopAudio: () => {
    const { getPlayer, activeFileId, filesPlaybackStartTime } = get();

    if (!activeFileId) {
      return;
    }

    const player = getPlayer();
    player.stop();

    set((s) => ({
      isPlaying: false,
      playerClock: {
        ...s.playerClock,
        startAt: null,
        startOffset: filesPlaybackStartTime[activeFileId],
      },
    }));
  },
});
