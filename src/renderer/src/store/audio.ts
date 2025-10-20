import * as Tone from "tone";
import { openFiles, player } from "./shared";
import type { AudioState, ZustandGet, ZustandSet } from "./types";

export const createAudioSlice = (set: ZustandSet, get: ZustandGet): AudioState => ({
  isPlaying: false,
  setIsPlaying: (isPlaying) => set({ isPlaying }),
  loop: false,
  setLoop: (loop) => {
    Tone.getTransport().loop = loop;
    // Clear auto-playback end time when enabling loop mode
    set({ loop, autoPlaybackEndTime: loop ? null : get().autoPlaybackEndTime });
  },
  autoPlaybackPaintedRegion: false,
  setAutoPlaybackPaintedRegion: (value) => set({ autoPlaybackPaintedRegion: value }),
  autoPlaybackEndTime: null,
  setAutoPlaybackEndTime: (time) => set({ autoPlaybackEndTime: time }),
  setPlaybackTime: (playbackTime) => {
    const { activeFileId, autoPlaybackEndTime } = get();

    if (activeFileId === null) return;

    const file = openFiles[activeFileId];
    if (!file || !file.audioBuffer) return;

    const transport = Tone.getTransport();
    transport.cancel();
    transport.seconds = playbackTime;

    transport.start();

    const stopTime = autoPlaybackEndTime !== null ? autoPlaybackEndTime : file.audioBuffer.duration;

    transport.schedule(() => {
      set({ isPlaying: false, autoPlaybackEndTime: null });
    }, stopTime);

    transport.stop(stopTime);
  },
  setFilePlaybackStartTime: (fileId, time) =>
    set((state: any) => ({
      fileSettings: {
        ...state.fileSettings,
        [openFiles[fileId]?.filePath]: {
          ...state.fileSettings[openFiles[fileId]?.filePath],
          playbackStartTime: time,
        },
      },
    })),
  togglePlayback: async () => {
    const { isPlaying, activeFileId, loop, fileSettings, autoPlaybackEndTime } = get();
    if (isPlaying) {
      const transport = Tone.getTransport();
      transport.stop();
      transport.cancel();
      return set({ isPlaying: false });
    }
    const file = activeFileId ? openFiles[activeFileId] : undefined;
    const audioBuffer = file?.audioBuffer;

    if (audioBuffer) {
      if (Tone.getContext().rawContext.state !== "running") {
        await Tone.start();
      }
      player.buffer = new Tone.ToneAudioBuffer(audioBuffer);

      const transport = Tone.getTransport();
      transport.bpm.value = fileSettings[file!.filePath].bpm;
      transport.setLoopPoints(0, audioBuffer.duration);
      transport.loop = loop;

      transport.cancel();

      // Start from the playback start time
      const startTime = fileSettings[file!.filePath].playbackStartTime || 0;
      transport.seconds = startTime;

      player.sync().start(0);
      transport.start();

      // Schedule stop at end of playback if not looping
      if (!loop) {
        const stopTime = autoPlaybackEndTime !== null ? autoPlaybackEndTime : audioBuffer.duration;

        transport.schedule(() => {
          set({ isPlaying: false, autoPlaybackEndTime: null });
        }, stopTime);

        transport.stop(stopTime);
      }

      return set({ isPlaying: true });
    } else {
      console.error("No audio buffer available to play.");
      return;
    }
  },
  stopAudio: () => {
    const transport = Tone.getTransport();
    transport.stop();
    transport.cancel();

    const { activeFileId, fileSettings } = get();
    if (activeFileId && openFiles[activeFileId]) {
      const file = openFiles[activeFileId];
      // Reset to playback start time instead of 0
      transport.seconds = fileSettings[file.filePath].playbackStartTime || 0;
    } else {
      transport.seconds = 0;
    }
    player.unsync(); // Unsync from transport
    player.stop();
    set({ isPlaying: false, autoPlaybackEndTime: null });
  },
});
