import { useStore } from "@/store";
import { openFiles } from "@/store/files";
import * as Tone from "tone";
import { useEffect, useRef } from "react";

function getActiveFileBpm(): number {
  const state = useStore.getState();
  const file = state.activeFileId ? openFiles[state.activeFileId] : undefined;
  if (!file) return 120;
  return state.filepathsBpm[file.filePath] ?? 120;
}

function applyPlaybackRate(linkTempo: number): void {
  const state = useStore.getState();
  const player = state.player;
  if (!player || !state.linkEnabled) return;

  const fileBpm = getActiveFileBpm();
  player.playbackRate = linkTempo / fileBpm;
}

/**
 * Seamlessly re-align an already-playing player to the Link session
 * using player.restart() to seek to the phase-correct position.
 */
function syncToLink(): void {
  const state = useStore.getState();
  const { player, isPlaying, activeFileId, linkEnabled, linkQuantum,
          linkLatencyMs, filepathsBpm, loop, loopRegion } = state;

  if (!player || !isPlaying || !activeFileId || !linkEnabled) return;
  if (!window.linkAddon?.isEnabled?.()) return;

  const file = activeFileId ? openFiles[activeFileId] : undefined;
  const buffer = file?.audioBuffer;
  if (!buffer || !file) return;

  const fileBpm = filepathsBpm[file.filePath] ?? 120;
  const linkState = window.linkAddon.captureState(linkQuantum);
  const rate = linkState.tempo / fileBpm;
  player.playbackRate = rate;

  const latencyBeats = (linkLatencyMs / 1000) * (linkState.tempo / 60);
  const adjustedBeat = linkState.beat + latencyBeats;

  const secondsPerBeat = 60 / fileBpm;
  const end = loopRegion?.end ?? buffer.duration;
  const loopStart = loopRegion?.start ?? 0;

  let offset: number;
  if (loop && loopRegion) {
    const loopLen = loopRegion.end - loopRegion.start;
    const loopLenBeats = loopLen / secondsPerBeat;
    const posInLoopBeats = ((adjustedBeat % loopLenBeats) + loopLenBeats) % loopLenBeats;
    offset = loopRegion.start + posInLoopBeats * secondsPerBeat;
  } else {
    const durationBeats = buffer.duration / secondsPerBeat;
    const posBeats = ((adjustedBeat % durationBeats) + durationBeats) % durationBeats;
    offset = posBeats * secondsPerBeat;
  }

  const ctx = Tone.getContext().rawContext;
  const startTime = ctx.currentTime + 0.001;
  if (loop) {
    player.loop = true;
    player.loopStart = loopStart;
    player.loopEnd = end;
    player.restart(startTime, offset);
  } else {
    player.restart(startTime, offset, Math.max(0, end - offset));
  }

  useStore.setState((s) => ({
    playerClock: {
      ...s.playerClock,
      startAt: Tone.now(),
      startOffset: offset,
      loopStart,
      loopEnd: end,
    },
  }));
}

export function useLinkSync(): void {
  const linkEnabled = useStore((s) => s.linkEnabled);
  const localTransportChangeRef = useRef(false);

  useEffect(() => {
    if (!linkEnabled) {
      const player = useStore.getState().player;
      if (player) player.playbackRate = 1;
      return;
    }

    if (!window.linkAddon) {
      console.error("Link addon not available");
      useStore.getState().setLinkEnabled(false);
      return;
    }

    try {
      window.linkAddon.create(getActiveFileBpm());
      window.linkAddon.setCallbacks({
        onTempoChanged: (tempo: number) => {
          const state = useStore.getState();
          state.onLinkTempoChanged(tempo);

          if (state.isPlaying && state.player) {
            const currentPos = state.getPlaybackTime();
            state.player.playbackRate = tempo / getActiveFileBpm();
            useStore.setState((s) => ({
              playerClock: {
                ...s.playerClock,
                startAt: Tone.now(),
                startOffset: currentPos,
              },
            }));
          } else {
            applyPlaybackRate(tempo);
          }
        },
        onStartStopChanged: (isPlaying: boolean) => {
          useStore.getState().onLinkStartStopChanged(isPlaying);
        },
        onNumPeersChanged: (numPeers: number) => {
          useStore.getState().onLinkNumPeersChanged(numPeers);
        },
      });
      window.linkAddon.enable();
      window.linkAddon.enableStartStopSync(true);

      const quantum = useStore.getState().linkQuantum;
      const initialState = window.linkAddon.captureState(quantum);
      useStore.getState().onLinkTempoChanged(initialState.tempo);
      useStore.getState().onLinkNumPeersChanged(initialState.numPeers);
      useStore.getState().onLinkStartStopChanged(initialState.isPlaying);

      const { isPlaying } = useStore.getState();
      if (isPlaying) {
        applyPlaybackRate(initialState.tempo);
        setTimeout(() => syncToLink(), 50);
      }
    } catch (err) {
      console.error("Failed to initialize Ableton Link:", err);
      useStore.getState().setLinkEnabled(false);
      return;
    }

    return () => {
      try {
        window.linkAddon.disable();
        window.linkAddon.destroy();
      } catch (err) {
        console.error("Failed to teardown Ableton Link:", err);
      }
      const player = useStore.getState().player;
      if (player) player.playbackRate = 1;
    };
  }, [linkEnabled]);

  // Sync transport state from Link peers
  useEffect(() => {
    if (!linkEnabled) return;

    const unsub = useStore.subscribe(
      (s) => s.linkIsPlaying,
      (linkIsPlaying) => {
        if (localTransportChangeRef.current) {
          localTransportChangeRef.current = false;
          return;
        }

        const state = useStore.getState();
        if (linkIsPlaying && !state.isPlaying) {
          state.togglePlayback();
        } else if (!linkIsPlaying && state.isPlaying) {
          state.stopAudio();
        }
      },
    );

    return unsub;
  }, [linkEnabled]);

  // Propagate local play/stop to Link peers
  useEffect(() => {
    if (!linkEnabled) return;

    const unsub = useStore.subscribe(
      (s) => s.isPlaying,
      (isPlaying) => {
        const linkIsPlaying = useStore.getState().linkIsPlaying;
        if (isPlaying !== linkIsPlaying) {
          localTransportChangeRef.current = true;
          window.linkAddon.setIsPlaying(isPlaying);
        }
      },
    );

    return unsub;
  }, [linkEnabled]);

  // Debug metronome — enable via window.__linkMetronome = true
  useEffect(() => {
    if (!linkEnabled) return;

    let rafId: number;
    let lastBeatInt = -1;
    let audioCtx: AudioContext | null = null;

    const tick = () => {
      if (!(window as unknown as Record<string, unknown>).__linkMetronome) {
        lastBeatInt = -1;
        rafId = requestAnimationFrame(tick);
        return;
      }

      const quantum = useStore.getState().linkQuantum;
      const state = window.linkAddon.captureState(quantum);
      const beatInt = Math.floor(state.beat);

      if (beatInt !== lastBeatInt && lastBeatInt !== -1) {
        if (!audioCtx) audioCtx = new AudioContext();
        const osc = audioCtx.createOscillator();
        const gain = audioCtx.createGain();
        osc.connect(gain);
        gain.connect(audioCtx.destination);
        osc.frequency.value = state.phase < 0.5 ? 1000 : 600;
        gain.gain.value = 0.3;
        gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.05);
        osc.start(audioCtx.currentTime);
        osc.stop(audioCtx.currentTime + 0.05);
      }
      lastBeatInt = beatInt;

      rafId = requestAnimationFrame(tick);
    };

    rafId = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(rafId);
      if (audioCtx) audioCtx.close();
    };
  }, [linkEnabled]);

  // Re-sync when latency changes during playback
  useEffect(() => {
    if (!linkEnabled) return;

    const unsub = useStore.subscribe(
      (s) => s.linkLatencyMs,
      () => {
        const state = useStore.getState();
        if (!state.isPlaying) return;
        syncToLink();
      },
    );

    return unsub;
  }, [linkEnabled]);

  // Apply playbackRate when active file changes
  useEffect(() => {
    if (!linkEnabled) return;

    const unsub = useStore.subscribe(
      (s) => s.activeFileId,
      () => {
        const state = useStore.getState();
        applyPlaybackRate(state.linkTempo);
      },
    );

    return unsub;
  }, [linkEnabled]);
}
