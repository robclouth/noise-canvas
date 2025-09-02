import { atom } from "jotai";
import * as Tone from "tone";
import { isPlayingAtom, store } from "./store";

// Atom to hold the synthesized audio buffer
export const audioBufferAtom = atom<AudioBuffer | null>(null);
export const playbackTimeAtom = atom(0);

const player = new Tone.Player().toDestination();
let animationFrameId: number;

const updatePlaybackTime = () => {
  store.set(playbackTimeAtom, Tone.Transport.seconds);
  animationFrameId = requestAnimationFrame(updatePlaybackTime);
};

export const playAudio = async () => {
  const buffer = store.get(audioBufferAtom);
  if (buffer) {
    if (Tone.getContext().rawContext.state !== "running") {
      await Tone.start();
    }
    Tone.Transport.cancel(0); // Clear any previously scheduled events
    player.buffer = new Tone.ToneAudioBuffer(buffer);
    player.sync().start(0);

    // Schedule the transport to stop at the end of the buffer
    Tone.Transport.scheduleOnce(() => {
      stopAudio();
    }, buffer.duration);

    Tone.Transport.start();
    updatePlaybackTime();
  } else {
    console.error("No audio buffer available to play.");
  }
};

export const stopAudio = () => {
  if (Tone.Transport.state === "started") {
    Tone.Transport.stop();
    Tone.Transport.cancel(0); // Clear scheduled events
    cancelAnimationFrame(animationFrameId);
    store.set(playbackTimeAtom, 0);
    store.set(isPlayingAtom, false);
  }
};
