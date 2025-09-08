import { atom } from "jotai";
import * as Tone from "tone";
import { isPlayingAtom, loopAtom, store } from "./store";

// Atom to hold the synthesized audio buffer
export const audioBufferAtom = atom<AudioBuffer | null>(null);
