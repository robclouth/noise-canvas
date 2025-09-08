import { useSetAtom } from "jotai";
import { useEffect } from "react";
import { DataTexture, FloatType, NearestFilter, RGBAFormat, RGBFormat, RGFormat, Vector2 } from "three";
import { notifications } from "@mantine/notifications";
import { RendererHandle } from "../components/renderer";
import { bandsPerOctaveAtom, filePathAtom, fminAtom, normalizeAtom, spectrogramDataAtom, store } from "../store";

export const useIpcListeners = (rendererRef: React.RefObject<RendererHandle | null>): void => {
  const setSpectrogramData = useSetAtom(spectrogramDataAtom);
  const setFilePath = useSetAtom(filePathAtom);

  useEffect(() => {
    const handleOpenFile = (filePath: string) => {
      setFilePath(filePath);
      const params = {
        bandsPerOctave: store.get(bandsPerOctaveAtom),
        fmin: store.get(fminAtom),
      };
      window.api.loadFile(filePath, params);
      store.set(spectrogramDataAtom, null);
    };

    if (process.env.NODE_ENV === "development") {
      handleOpenFile("/Users/rob/Documents/Projects/Music/Tools/Noise Canvas Python/input/garage.mp3");
    }

    const unsubOpenFile = window.api.onOpenFile((path) => {
      handleOpenFile(path);
    });

    const unsubTriggerOpenFile = window.api.onTriggerOpenFile(async () => {
      try {
        const analysisParams = {
          bandsPerOctave: store.get(bandsPerOctaveAtom),
          fmin: store.get(fminAtom),
        };
        const result = await window.api.openFileAndAnalyze(analysisParams);
        if (result && result.filePath) {
          handleOpenFile(result.filePath);
        }
      } catch (error) {
        console.error("Error opening file:", error);
        notifications.show({
          title: "Analysis Error",
          message: "An error occurred while analyzing the audio.",
          color: "red",
        });
      }
    });

    const unsubAnalysisComplete = window.api.onAnalysisComplete((payload) => {
      const packedDataTex = new DataTexture(
        new Float32Array(payload.data.buffer, payload.data.byteOffset, payload.data.byteLength / 4),
        payload.textureWidth,
        payload.textureHeight,
        RGBAFormat,
        FloatType,
      );
      packedDataTex.internalFormat = "RGBA32F";
      packedDataTex.minFilter = NearestFilter;
      packedDataTex.magFilter = NearestFilter;
      packedDataTex.needsUpdate = true;

      const inverseMapTex = new DataTexture(
        new Float32Array(payload.inverseMap.buffer, payload.inverseMap.byteOffset, payload.inverseMap.byteLength / 4),
        payload.textureWidth,
        payload.textureHeight,
        RGFormat,
        FloatType,
      );
      inverseMapTex.internalFormat = "RG32F";
      inverseMapTex.minFilter = NearestFilter;
      inverseMapTex.magFilter = NearestFilter;
      inverseMapTex.needsUpdate = true;

      const metadataTex = new DataTexture(
        new Float32Array(
          payload.metadataTexture.buffer,
          payload.metadataTexture.byteOffset,
          payload.metadataTexture.byteLength / 4,
        ),
        payload.numBands,
        1,
        RGBFormat,
        FloatType,
      );
      metadataTex.internalFormat = "RGB32F";
      metadataTex.minFilter = NearestFilter;
      metadataTex.magFilter = NearestFilter;
      metadataTex.needsUpdate = true;

      setSpectrogramData({
        packedDataTex,
        inverseMapTex,
        metadataTex,
        numFrames: payload.numFrames,
        numBands: payload.numBands,
        numChannels: payload.numChannels,
        sampleRate: payload.sampleRate,
        packedTextureSize: new Vector2(payload.textureWidth, payload.textureHeight),
        synthesisMetadata: {
          bandOffsets: payload.bandOffsets,
          bandStepLog2s: payload.bandStepLog2s,
          bandLengths: payload.bandLengths,
        },
      });
      window.api.clearUndoState();
    });

    const unsubAnalysisError = window.api.onAnalysisError(() => {
      notifications.show({
        title: "Analysis Error",
        message: "An error occurred while analyzing the audio.",
        color: "red",
      });
    });

    const unsubUndo = window.api.onUndoApplyState((data) => {
      rendererRef.current?.setFBOData(
        new Float32Array(data.buffer, data.byteOffset, data.byteLength / Float32Array.BYTES_PER_ELEMENT),
      );
    });

    const unsubRequestAudioForSaving = window.api.onRequestAudioForSaving(async () => {
      if (!rendererRef.current) {
        return;
      }
      const processedData = rendererRef.current.getFBOData();
      const spectrogramData = store.get(spectrogramDataAtom);
      if (!processedData || !spectrogramData) {
        return;
      }

      const analysisParams = {
        bandsPerOctave: store.get(bandsPerOctaveAtom),
        fmin: store.get(fminAtom),
      };
      const payload = {
        processedData: processedData.buffer,
        analysisMetadata: {
          numFrames: spectrogramData.numFrames,
          numChannels: spectrogramData.numChannels,
          numBands: spectrogramData.numBands,
          ...spectrogramData.synthesisMetadata,
        },
      };
      const normalize = store.get(normalizeAtom);

      try {
        await window.api.saveAudioData(payload, analysisParams, normalize);
        notifications.show({
          title: "Success",
          message: "File saved successfully!",
          color: "green",
        });
        console.log("File saved successfully!");
      } catch (e) {
        console.error("Failed to save audio", e);
        notifications.show({
          title: "Failed to save file",
          message: e instanceof Error ? e.message : "An unknown error occurred.",
          color: "red",
        });
      }
    });

    return () => {
      unsubOpenFile();
      unsubTriggerOpenFile();
      unsubAnalysisComplete();
      unsubAnalysisError();
      unsubUndo();
      unsubRequestAudioForSaving();
    };
  }, [setSpectrogramData, rendererRef]);
};
