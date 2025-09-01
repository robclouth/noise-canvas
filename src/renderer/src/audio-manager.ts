import { atom } from "jotai";
import * as Tone from "tone";
import { store } from "./store";

// Atom to hold the synthesized audio buffer
export const audioBufferAtom = atom<AudioBuffer | null>(null);

const player = new Tone.Player().toDestination();

export const playAudio = async () => {
  const buffer = store.get(audioBufferAtom);
  if (buffer) {
    if (Tone.getContext().rawContext.state !== "running") {
      await Tone.start();
    }
    player.buffer = new Tone.ToneAudioBuffer(buffer);
    player.start();
  } else {
    console.error("No audio buffer available to play.");
  }
};

export const stopAudio = () => {
  if (player.state === "started") {
    player.stop();
  }
};
