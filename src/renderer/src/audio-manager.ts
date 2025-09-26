import * as Tone from "tone";
import { openFiles, useStore } from "./store";

const player = new Tone.Player().toDestination();
let animationFrameId: number;

export const runSynthesis = async (filePath: string, processedData: Float32Array): Promise<void> => {
  try {
    console.log("runSynthesis");
    const { normalize, bandsPerOctave, minFreq, isPlaying, activeFilePath, loop } = useStore.getState();
    const file = openFiles[filePath];
    if (!file) {
      return;
    }

    const originalAnalysis = file.spectrogramData;

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
      bandsPerOctave: bandsPerOctave.value,
      minFreq: minFreq.value,
    };
    const audioBufferChannels = await window.api.synthesizeAudio(payload, analysisParams, normalize.value);

    if (audioBufferChannels.length === 0) {
      throw new Error("Synthesis returned no audio channels.");
    }

    const numChannels = audioBufferChannels.length;
    const numFrames = audioBufferChannels[0].length;

    const audioContext = Tone.getContext().rawContext;
    const audioBuffer = audioContext.createBuffer(numChannels, numFrames, originalAnalysis.sampleRate);

    for (let c = 0; c < numChannels; c++) {
      audioBuffer.copyToChannel(new Float32Array(audioBufferChannels[c]), c);
    }

    file.audioBuffer = audioBuffer;

    if (isPlaying && activeFilePath && activeFilePath === filePath) {
      const transport = Tone.getTransport();
      let currentTime = transport.seconds;
      const newDuration = audioBuffer.duration;

      if (loop) {
        currentTime %= newDuration;
      } else if (currentTime >= newDuration) {
        stopAudio();
        return;
      }

      transport.cancel(0);

      player.buffer = new Tone.ToneAudioBuffer(audioBuffer);
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
    useStore.getState().setIsSynthesizing(false);
  }
};

const updatePlaybackTime = () => {
  const { loop, activeFilePath, setPlaybackTime } = useStore.getState();
  const file = activeFilePath ? openFiles[activeFilePath] : undefined;
  const audioBuffer = file?.audioBuffer;
  let currentTime = Tone.getTransport().seconds;

  if (loop && audioBuffer && player.state === "started") {
    currentTime %= audioBuffer.duration;
  }
  setPlaybackTime(currentTime);
  animationFrameId = requestAnimationFrame(updatePlaybackTime);
};

export const togglePlayback = async () => {
  const { isPlaying, activeFilePath, loop, setIsPlaying } = useStore.getState();
  if (isPlaying) {
    stopAudio();
    return;
  }
  const file = activeFilePath ? openFiles[activeFilePath] : undefined;
  const audioBuffer = file?.audioBuffer;

  if (audioBuffer) {
    if (Tone.getContext().rawContext.state !== "running") {
      await Tone.start();
    }
    player.buffer = new Tone.ToneAudioBuffer(audioBuffer);
    player.loop = loop;
    player.sync().start(0);

    const transport = Tone.getTransport();

    if (!loop) {
      transport.scheduleOnce(() => {
        stopAudio();
      }, audioBuffer.duration);
    }

    transport.start();
    setIsPlaying(true);
    updatePlaybackTime();
  } else {
    console.error("No audio buffer available to play.");
  }
};

export const stopAudio = () => {
  if (Tone.getTransport().state === "started") {
    const { setPlaybackTime, setIsPlaying } = useStore.getState();
    const transport = Tone.getTransport();
    transport.stop();
    transport.cancel(0); // Clear scheduled events
    cancelAnimationFrame(animationFrameId);
    setPlaybackTime(0);
    setIsPlaying(false);
  }
};
