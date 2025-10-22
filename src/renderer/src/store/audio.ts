import * as Tone from "tone";
import { openFiles } from "./files";
import type { AudioState, PlayerClock, ZustandGet, ZustandSet } from "./types";

export const createAudioSlice = (set: ZustandSet, get: ZustandGet): AudioState => ({
  player: null,
  playerClock: {
    startAt: null,
    startOffset: 0,
    loopStart: 0,
    loopEnd: 0,
  },

  getPlaybackTime: () => {
    const { player, isPlaying, loop, autoPlayEndTime: autoPlaybackEndTime, activeFileId, playerClock } = get();
    const file = activeFileId ? openFiles[activeFileId] : undefined;
    const buffer = file?.audioBuffer;
    if (!player || !buffer) return 0;

    const end = autoPlaybackEndTime ?? buffer.duration;

    if (!isPlaying || playerClock.startAt === null) {
      return Math.min(Math.max(playerClock.startOffset, playerClock.loopStart), end);
    }

    const now = Tone.now();
    const elapsed = Math.max(0, now - playerClock.startAt);
    let pos = playerClock.startOffset + elapsed;

    if (loop) {
      const L0 = 0;
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
    const { player, isPlaying, autoPlayEndTime, activeFileId, getPlaybackTime } = get();
    const file = activeFileId ? openFiles[activeFileId] : undefined;
    const buffer = file?.audioBuffer;

    if (!isPlaying || !player || !buffer) {
      set({ loop });
      return;
    }

    const currentTime = getPlaybackTime();
    set({ loop });
    const end = autoPlayEndTime ?? buffer.duration;

    // ** THE FIX **
    // Use player.restart() to prevent audio scheduling race conditions.
    // First, update the player's internal loop property.
    player.loop = loop;

    if (loop) {
      // When starting a loop, duration is not needed.
      player.restart(Tone.now(), currentTime);
    } else {
      // When stopping a loop, we must provide the remaining duration.
      const remainingDuration = Math.max(0, end - currentTime);
      player.restart(Tone.now(), currentTime, remainingDuration);
    }

    // Resynchronize our internal clock to match the new player state.
    set((s) => ({
      playerClock: {
        ...s.playerClock,
        startAt: Tone.now(),
        startOffset: currentTime,
      },
    }));
  },

  autoPlayStroke: false,
  setAutoPlayStroke: (value) => set({ autoPlayStroke: value }),

  autoPlayEndTime: null,
  setAutoPlayEndTime: (time) => set({ autoPlayEndTime: time }),

  setPlaybackTime: (playbackTime) => {
    const { activeFileId, autoPlayEndTime, loop, getPlayer } = get();
    if (activeFileId === null) return;
    const file = openFiles[activeFileId];
    const buf = file?.audioBuffer;
    if (!buf) return;

    const player = getPlayer();
    const end = autoPlayEndTime ?? buf.duration;
    const offset = Math.min(Math.max(playbackTime, 0), end);

    set((s) => ({
      playerClock: {
        ...s.playerClock,
        startAt: Tone.now(),
        startOffset: offset,
        loopStart: 0,
        loopEnd: end,
      },
    }));

    if (player.state === "started") {
      // Also use restart here for consistency and safety.
      if (loop) {
        player.loop = true;
        player.loopStart = 0;
        player.loopEnd = end;
        player.restart(Tone.now(), offset);
      } else {
        player.loop = false;
        player.restart(Tone.now(), offset, Math.max(0, end - offset));
      }
    }
  },

  setFilePlaybackStartTime: (fileId, time) =>
    set((state) => ({
      fileSettings: {
        ...state.fileSettings,
        [openFiles[fileId]?.filePath]: {
          ...state.fileSettings[openFiles[fileId]?.filePath],
          playbackStartTime: time,
        },
      },
    })),

  togglePlayback: async () => {
    const state = get();
    const { isPlaying, activeFileId, loop, fileSettings, autoPlayEndTime, getPlayer } = state;

    if (isPlaying) {
      return state.stopAudio();
    }

    const file = activeFileId ? openFiles[activeFileId] : undefined;
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

    const startTime = fileSettings[file!.filePath].playbackStartTime || 0;
    const end = autoPlayEndTime ?? buffer.duration;
    const offset = Math.min(Math.max(startTime, 0), end);

    if (loop) {
      player.loop = true;
      player.loopStart = 0;
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
        loopStart: 0,
        loopEnd: end,
      } as PlayerClock,
    });
  },

  stopAudio: () => {
    const { getPlayer, activeFileId, fileSettings } = get();
    const player = getPlayer();
    player.stop();

    let restartOffset = 0;
    if (activeFileId && openFiles[activeFileId]) {
      const file = openFiles[activeFileId];
      restartOffset = fileSettings[file.filePath]?.playbackStartTime || 0;
    }

    set((s) => ({
      isPlaying: false,
      autoPlayEndTime: null,
      playerClock: {
        ...s.playerClock,
        startAt: null,
        startOffset: restartOffset,
      },
    }));
  },
});
