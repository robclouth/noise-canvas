import * as Tone from "tone";
import { openFiles, useStore } from "./store";

const player = new Tone.Player().toDestination();
let animationFrameId: number;

export const runSynthesis = async (filePath: string): Promise<void> => {
  try {
    const totalStart = performance.now();
    console.log("runSynthesis");
    const { normalize, bandsPerOctave, minFreq, isPlaying, activeFilePath, loop } = useStore.getState();
    const file = openFiles[filePath];
    if (!file || !file.rendererRef?.current) {
      return;
    }

    const originalAnalysis = file.spectrogramData;

    // Assemble the payload for the main process
    const fboData = await file.rendererRef.current.getFBOData();
    const payload = {
      processedData: fboData.buffer,
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

    const ipcStart = performance.now();
    const audioBufferChannels = await window.api.synthesizeAudio(payload, analysisParams, normalize.value);
    const ipcTime = performance.now() - ipcStart;
    console.log("IPC transfer took:", ipcTime.toFixed(2), "ms");

    if (audioBufferChannels.length === 0) {
      throw new Error("Synthesis returned no audio channels.");
    }

    const numChannels = audioBufferChannels.length;
    const numFrames = audioBufferChannels[0].length;

    const audioContext = Tone.getContext().rawContext;
    const audioBuffer = audioContext.createBuffer(numChannels, numFrames, originalAnalysis.sampleRate);

    // Copy channels in a non-blocking way using async iteration
    const copyStart = performance.now();
    await new Promise<void>((resolve) => {
      let channelIndex = 0;

      const copyNextChannel = () => {
        if (channelIndex < numChannels) {
          // Convert Buffer to Float32Array efficiently
          const channelBuffer = audioBufferChannels[channelIndex] as any;
          let channelData: Float32Array;

          if (channelBuffer instanceof Float32Array) {
            channelData = channelBuffer;
          } else if (ArrayBuffer.isView(channelBuffer)) {
            // It's a Buffer or typed array view - create a view without copying
            channelData = new Float32Array(
              channelBuffer.buffer as ArrayBuffer,
              channelBuffer.byteOffset as number,
              (channelBuffer.byteLength as number) / Float32Array.BYTES_PER_ELEMENT,
            );
          } else {
            // Fallback for plain array
            channelData = new Float32Array(channelBuffer);
          }

          audioBuffer.copyToChannel(channelData as Float32Array<ArrayBuffer>, channelIndex);
          channelIndex++;

          // Yield to the event loop between channels
          setTimeout(copyNextChannel, 0);
        } else {
          resolve();
        }
      };

      copyNextChannel();
    });
    const copyTime = performance.now() - copyStart;
    console.log("Channel copy took:", copyTime.toFixed(2), "ms");

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

    const totalTime = performance.now() - totalStart;
    console.log("Total synthesis took:", totalTime.toFixed(2), "ms");
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
