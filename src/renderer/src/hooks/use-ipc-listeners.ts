import { notifications } from "@mantine/notifications";
import { useAtom, useSetAtom } from "jotai";
import { useEffect } from "react";
import { DataTexture, FloatType, NearestFilter, RGBAFormat, RGBFormat, RGFormat, Vector2 } from "three";
import {
  activeFileAtom,
  activeFileIdAtom,
  bandsPerOctaveAtom,
  closeFile,
  fminAtom,
  normalizeAtom,
  openFilesAtom,
  store,
} from "../store";

let currentFilePath: string | null = null;

export const useIpcListeners = (): void => {
  const [openFiles, setOpenFiles] = useAtom(openFilesAtom);
  const setActiveFileId = useSetAtom(activeFileIdAtom);

  useEffect(() => {
    const handleOpenFile = (filePath: string) => {
      currentFilePath = filePath;
      const params = {
        bandsPerOctave: store.get(bandsPerOctaveAtom),
        fmin: store.get(fminAtom),
      };
      window.api.loadFile(filePath, params);
    };

    if (process.env.NODE_ENV === "development") {
      if (openFiles.length === 0)
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

    const unsubCloseActiveFile = window.api.onCloseActiveFile(() => {
      const activeFile = store.get(activeFileAtom);
      if (activeFile) {
        closeFile(activeFile.id);
      }
    });

    const unsubCloseAllFiles = window.api.onCloseAllFiles(() => {
      setOpenFiles([]);
      setActiveFileId(null);
    });

    const unsubAnalysisComplete = window.api.onAnalysisComplete((payload) => {
      if (!currentFilePath) {
        console.error("Analysis completed but no file path is set.");
        return;
      }

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

      const newFile = {
        id: crypto.randomUUID(),
        filePath: currentFilePath,
        spectrogramData: {
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
        },
      };

      setOpenFiles((files) => [...files, newFile]);
      setActiveFileId(newFile.id);

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
      const activeFile = store.get(activeFileAtom);
      if (activeFile?.renderer?.current) {
        activeFile.renderer.current.setFBOData(
          new Float32Array(data.buffer, data.byteOffset, data.byteLength / Float32Array.BYTES_PER_ELEMENT),
        );
      }
    });

    const unsubRequestAudioForSaving = window.api.onRequestAudioForSaving(async () => {
      const activeFile = store.get(activeFileAtom);
      if (!activeFile?.renderer?.current) {
        return;
      }

      const processedData = activeFile.renderer.current.getFBOData();
      const spectrogramData = activeFile.spectrogramData;
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
      unsubCloseActiveFile();
      unsubCloseAllFiles();
    };
  }, [setOpenFiles, setActiveFileId, openFiles.length]);
};
