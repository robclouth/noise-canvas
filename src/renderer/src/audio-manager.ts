import { atom } from "jotai";
import * as Tone from "tone";
import {
  activeFileAtom,
  audioBufferAtom,
  bandsPerOctaveAtom,
  fminAtom,
  isPlayingAtom,
  loopAtom,
  normalizeAtom,
  OpenFile,
  openFilesAtom,
  store,
} from "./store";

export const playbackTimeAtom = atom(0);
export const isSynthesizingAtom = atom(false);

const player = new Tone.Player().toDestination();
let animationFrameId: number;

export const runSynthesis = async (file: OpenFile, processedData: Float32Array): Promise<void> => {
  try {
    const originalAnalysis = file.spectrogramData;
    const normalize = store.get(normalizeAtom);

    // Assemble the payload for the main process
    const payload = {
      processedData: processedData.buffer,
      analysisMetadata: {
        numFrames: originalAnalysis.numFrames,
        numChannels: originalAnalysis.numChannels,
        numBands: originalAnalysis.numBands,
        ...originalAnalysis.synthesisMetadata,
      },
    };

    const analysisParams = {
      bandsPerOctave: store.get(bandsPerOctaveAtom),
      fmin: store.get(fminAtom),
    };
    const audioBufferArray: Float32Array = await window.api.synthesizeAudio(payload, analysisParams, normalize);

    const audioContext = Tone.getContext().rawContext;
    const numFrames = audioBufferArray.length / originalAnalysis.numChannels;

    const audioBuffer = audioContext.createBuffer(originalAnalysis.numChannels, numFrames, originalAnalysis.sampleRate);

    // For each channel, copy the samples from the interleaved array
    for (let c = 0; c < originalAnalysis.numChannels; c++) {
      const channelData = audioBuffer.getChannelData(c);
      for (let i = 0; i < numFrames; i++) {
        // Pick samples from the interleaved array
        channelData[i] = audioBufferArray[i * originalAnalysis.numChannels + c];
      }
    }

    store.set(openFilesAtom, (openFiles) => ({ ...openFiles, [file.filePath]: { ...file, audioBuffer } }));

    const isPlaying = store.get(isPlayingAtom);
    const activeFile = store.get(activeFileAtom);

    if (isPlaying && activeFile && activeFile.filePath === file.filePath && activeFile.audioBuffer) {
      const transport = Tone.getTransport();
      let currentTime = transport.seconds;
      const loop = store.get(loopAtom);
      const newDuration = activeFile.audioBuffer.duration;

      if (loop) {
        currentTime %= newDuration;
      } else if (currentTime >= newDuration) {
        stopAudio();
        return;
      }

      transport.cancel(0);

      player.buffer = new Tone.ToneAudioBuffer(activeFile.audioBuffer);
      player.loop = loop;

      if (!loop) {
        transport.scheduleOnce(() => {
          stopAudio();
        }, newDuration);
      }
      player.seek(currentTime);
    }
  } catch (error) {
    console.error("Error running synthesis:", error);
  } finally {
    store.set(isSynthesizingAtom, false);
  }
};

const updatePlaybackTime = () => {
  const loop = store.get(loopAtom);
  const buffer = store.get(audioBufferAtom);
  let currentTime = Tone.getTransport().seconds;

  if (loop && buffer && player.state === "started") {
    currentTime %= buffer.duration;
  }
  store.set(playbackTimeAtom, currentTime);
  animationFrameId = requestAnimationFrame(updatePlaybackTime);
};

export const togglePlayback = async () => {
  const isCurrentlyPlaying = store.get(isPlayingAtom);
  if (isCurrentlyPlaying) {
    stopAudio();
    return;
  }

  const activeFile = store.get(activeFileAtom);

  if (activeFile?.audioBuffer) {
    if (Tone.getContext().rawContext.state !== "running") {
      await Tone.start();
    }
    player.buffer = new Tone.ToneAudioBuffer(activeFile.audioBuffer);
    const loop = store.get(loopAtom);
    player.loop = loop;
    player.sync().start(0);

    const transport = Tone.getTransport();

    if (!loop) {
      transport.scheduleOnce(() => {
        stopAudio();
      }, activeFile.audioBuffer.duration);
    }

    transport.start();
    store.set(isPlayingAtom, true);
    updatePlaybackTime();
  } else {
    console.error("No audio buffer available to play.");
  }
};

export const stopAudio = () => {
  if (Tone.getTransport().state === "started") {
    const transport = Tone.getTransport();
    transport.stop();
    transport.cancel(0); // Clear scheduled events
    cancelAnimationFrame(animationFrameId);
    store.set(playbackTimeAtom, 0);
    store.set(isPlayingAtom, false);
  }
};
