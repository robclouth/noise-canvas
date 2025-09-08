import { atom } from "jotai";
import * as Tone from "tone";
import { isPlayingAtom, loopAtom, store } from "./store";

// Atom to hold the synthesized audio buffer
export const audioBufferAtom = atom<AudioBuffer | null>(null);
export const playbackTimeAtom = atom(0);

const player = new Tone.Player().toDestination();
let animationFrameId: number;

const updatePlaybackTime = () => {
  const loop = store.get(loopAtom);
  const buffer = store.get(audioBufferAtom);
  let currentTime = Tone.Transport.seconds;
  if (loop && buffer && player.state === "started") {
    currentTime %= buffer.duration;
  }
  store.set(playbackTimeAtom, currentTime);
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

    const loop = store.get(loopAtom);
    player.loop = loop;

    player.sync().start(0);

    // Schedule the transport to stop at the end of the buffer ONLY if not looping
    if (!loop) {
      Tone.Transport.scheduleOnce(() => {
        stopAudio();
      }, buffer.duration);
    }

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
