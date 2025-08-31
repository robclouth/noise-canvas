import { atom, createStore } from "jotai";

export const store = createStore();

export interface SpectrogramTexture {
  data: Buffer;
  width: number;
  height: number;
}

export interface RenderedSpectrogram {
  textures: SpectrogramTexture[];
  width: number;
  height: number;
  channels: number;
}

// This will hold the raw spectrogram data returned from the analysis
export const spectrogramDataAtom = atom<RenderedSpectrogram | null>(null);

const analysisParams = {
  bandsPerOctave: 96,
  fmin: 20.0,
};

export const runAnalysis = async (filePath: string): Promise<void> => {
  const analysisResult = await window.electron.ipcRenderer.invoke("analyze-audio", filePath, analysisParams);

  store.set(spectrogramDataAtom, analysisResult);
};

export const openAudioFile = async (): Promise<void> => {
  const filePath = await window.electron.ipcRenderer.invoke("open-file-dialog");
  if (filePath) {
    await runAnalysis(filePath);
  }
};
